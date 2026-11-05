import { ToolError,type Env,type Rec,type ToolSpec } from '../types';
import { SapODataClient,sapService } from './sap-odata';

const text=(value:unknown,label:string,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new ToolError('invalid_arguments',`An explicit ${label} is required.`);return value;};
const schema=(maxLength:number)=>({type:'string',minLength:1,maxLength});
const partnerFields=['BusinessPartner','BusinessPartnerCategory','BusinessPartnerGrouping','CorrespondenceLanguage','FirstName','LastName','OrganizationBPName1','SearchTerm2','to_Customer'];
const salesFields=['Customer','SalesOrganization','DistributionChannel','Division','Currency','CustomerPaymentTerms','CustomerAccountAssignmentGroup','ShippingCondition'];
const same=(actual:Rec,expected:Rec)=>Object.entries(expected).every(([key,value])=>actual[key]===value);
const record=(row:Rec)=>{
  const customer=row.to_Customer;
  if(!customer||typeof customer.Customer!=='string'||!customer.Customer.trim())throw new ToolError('receipt_unavailable','SAP has not confirmed the business partner to customer relationship.');
  return{businessPartnerId:row.BusinessPartner,customerId:customer.Customer,customerReference:row.SearchTerm2,category:row.BusinessPartnerCategory,customerAccountGroup:customer.CustomerAccountGroup};
};

/** SAP Business Partner A2X deep-create contract. Scope SAP_COM_0008 is required.
 * SearchTerm2 is an exact owned integration reference, not fuzzy name matching.
 * Native to_Customer supplies the sold-to ID; BP and Customer IDs may differ.
 * Country/sales/company classifications are explicitly reviewed input. */
export function sapCustomerTools(env:Env,client:SapODataClient):ToolSpec[]{
  return[
    {name:'get_customer',staffOnly:true,readOnly:true,
      description:'Read an exact SAP business partner/customer link by native BP ID or unique owned integration reference. Returns the Customer ID from the native to_Customer relation, never assumes BP/customer IDs or matches a name.',
      inputSchema:{type:'object',additionalProperties:false,properties:{businessPartnerId:schema(10),customerReference:schema(20)},anyOf:[{required:['businessPartnerId']},{required:['customerReference']}]},
      async run(args){
        const predicates=[...(args.businessPartnerId?[{field:'BusinessPartner',value:text(args.businessPartnerId,'business partner ID',10)}]:[]),...(args.customerReference?[{field:'SearchTerm2',value:text(args.customerReference,'owned customer reference',20)}]:[])];
        if(!predicates.length)throw new ToolError('invalid_arguments','An exact SAP partner ID or owned customer reference is required.');
        const found=await client.list(sapService(env,'CUSTOMER'),'A_BusinessPartner',{fields:partnerFields,predicates,expand:['to_Customer'],limit:2});
        if(!found.records.length)throw new ToolError('not_found','No exact SAP customer reference exists.');
        if(found.more||found.records.length!==1)throw new ToolError('ambiguous','The SAP customer reference is not unique; no customer was selected.');
        return{record:record(found.records[0]),source:'sap-s4hana',sample:false};
      }},
    {name:'create_customer',staffOnly:true,readOnly:false,
      description:'Create one exactly approved owned SAP business partner/customer master using explicit grouping, account group, source sales-area settings and address. Requires a stable JAX-owned reference. Reconcile exact source fields, customer role and sales area after success/lost response; never clone or name-match an unrelated sold-to. Does not post finance, send email or mark a commerce order fulfilled.',
      inputSchema:{type:'object',additionalProperties:false,required:['customerReference','category','grouping','correspondenceLanguage','customerAccountGroup','customerRole','country','city','salesArea'],properties:{customerReference:{...schema(20),pattern:'^JAX[A-Z0-9_-]{3,17}$'},category:{type:'string',enum:['1','2']},grouping:schema(4),correspondenceLanguage:schema(2),customerAccountGroup:schema(4),customerRole:{type:'string',enum:['FLCU01']},firstName:schema(40),lastName:schema(40),organizationName:schema(40),country:schema(2),region:schema(3),city:schema(40),postalCode:schema(10),street:schema(60),houseNumber:schema(10),salesArea:{type:'object',additionalProperties:false,required:['salesOrganization','distributionChannel','division','currency','paymentTerms','accountAssignmentGroup','shippingCondition'],properties:{salesOrganization:schema(4),distributionChannel:schema(2),division:schema(2),currency:{type:'string',pattern:'^[A-Z]{3}$'},paymentTerms:schema(4),accountAssignmentGroup:schema(2),shippingCondition:schema(2)}}}},
      async run(args,execution){
        if(!execution?.actionId||!execution.tenantId||!execution.environmentId||!execution.principalId||!execution.releaseChecksum)throw new ToolError('not_authorised','A verified exact SAP customer-master approval is required.');
        const service=sapService(env,'CUSTOMER');
        const reference=text(args.customerReference,'stable owned customer reference',20);
        if(!/^JAX[A-Z0-9_-]{3,17}$/.test(reference)||!['1','2'].includes(args.category)||args.customerRole!=='FLCU01')throw new ToolError('invalid_arguments','An owned JAX reference, explicit person/organisation category and native sales-customer role are required.');
        const expected:Rec={SearchTerm2:reference,BusinessPartnerCategory:args.category,BusinessPartnerGrouping:text(args.grouping,'BP grouping',4),CorrespondenceLanguage:text(args.correspondenceLanguage,'correspondence language',2),...(args.category==='1'?{FirstName:text(args.firstName,'first name',40),LastName:text(args.lastName,'last name',40)}:{OrganizationBPName1:text(args.organizationName,'organisation name',40)})};
        const accountGroup=text(args.customerAccountGroup,'customer account group',4),sales=args.salesArea;
        if(!sales||typeof sales!=='object')throw new ToolError('invalid_arguments','Explicit reviewed SAP sales-area configuration is required.');
        const area={SalesOrganization:text(sales.salesOrganization,'sales organisation',4),DistributionChannel:text(sales.distributionChannel,'distribution channel',2),Division:text(sales.division,'division',2),Currency:text(sales.currency,'order currency',3),CustomerPaymentTerms:text(sales.paymentTerms,'payment terms',4),CustomerAccountAssignmentGroup:text(sales.accountAssignmentGroup,'customer account assignment group',2),ShippingCondition:text(sales.shippingCondition,'shipping condition',2)};
        if(!/^[A-Z]{3}$/.test(area.Currency))throw new ToolError('invalid_arguments','An authoritative order currency is required.');
        const address:Rec={Country:text(args.country,'country',2),CityName:text(args.city,'city',40)};
        for(const[field,native,max]of [['region','Region',3],['postalCode','PostalCode',10],['street','StreetName',60],['houseNumber','HouseNumber',10]]as const)if(args[field]!==undefined)address[native]=text(args[field],field,max);
        const read=async()=>{
          const found=await client.list(service,'A_BusinessPartner',{fields:partnerFields,predicates:[{field:'SearchTerm2',value:reference}],expand:['to_Customer'],limit:2});
          if(!found.records.length)return undefined;
          if(found.more||found.records.length!==1||!same(found.records[0],expected))throw new ToolError('conflict','The owned SAP reference is ambiguous or has different approved identity fields; no customer was overwritten.');
          const row=found.records[0],identity=record(row);
          if(identity.customerAccountGroup!==accountGroup)throw new ToolError('conflict','The SAP customer account group differs from the approved mapping.');
          const roles=await client.list(service,'A_BusinessPartnerRole',{fields:['BusinessPartner','BusinessPartnerRole'],predicates:[{field:'BusinessPartner',value:identity.businessPartnerId},{field:'BusinessPartnerRole',value:args.customerRole}],limit:2});
          const areas=await client.list(service,'A_CustomerSalesArea',{fields:salesFields,predicates:[{field:'Customer',value:identity.customerId},{field:'SalesOrganization',value:area.SalesOrganization},{field:'DistributionChannel',value:area.DistributionChannel},{field:'Division',value:area.Division}],limit:2});
          const addresses=await client.list(service,'A_BusinessPartnerAddress',{fields:['BusinessPartner',...Object.keys(address)],predicates:[{field:'BusinessPartner',value:identity.businessPartnerId}],limit:50});
          if(roles.more||roles.records.length!==1||areas.more||areas.records.length!==1||!same(areas.records[0],area)||!addresses.records.some(row=>same(row,address)))throw new ToolError('conflict','SAP has not confirmed the exact reviewed customer role, address and sales-area settings.');
          return{record:{...identity,salesArea:{salesOrganization:area.SalesOrganization,distributionChannel:area.DistributionChannel,division:area.Division,currency:area.Currency}},source:'sap-s4hana',sample:false};
        };
        const prior=await read();if(prior)return{...prior,created:false,reconciled:true};
        const body={...expected,to_BusinessPartnerRole:{results:[{BusinessPartnerRole:args.customerRole}]},to_BusinessPartnerAddress:{results:[address]},to_Customer:{CustomerAccountGroup:accountGroup,to_CustomerSalesArea:{results:[area]}}};
        try{await client.create(service,'A_BusinessPartner',body);}catch(error){try{const receipt=await read();if(receipt)return{...receipt,created:true,reconciled:true};}catch{}throw error;}
        const receipt=await read();if(!receipt)throw new ToolError('receipt_unavailable','No native customer-master receipt is available; reconcile the action before retrying.');
        return{...receipt,created:true};
      }},
  ];
}

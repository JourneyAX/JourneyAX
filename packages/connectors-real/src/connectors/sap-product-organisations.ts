import { ToolError,type Env,type Rec,type ToolSpec } from '../types';
import { SapODataClient,sapService } from './sap-odata';

const text=(value:unknown,label:string,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new ToolError('invalid_arguments',`An explicit ${label} is required.`);return value;};
const key=(maxLength:number)=>({type:'string',minLength:1,maxLength});
const exact=(actual:Rec,expected:Rec)=>Object.entries(expected).every(([field,value])=>actual[field]===value);

/** Adds source-reviewed organisational views only. Physical properties, stock,
 * supplier relationships, tax equivalence and fulfilment are never invented.
 * Existing matching views are receipts; differing views are never overwritten.
 * A replay completes only missing views after a partial source success. */
export function sapProductOrganisationTools(env:Env,client:SapODataClient):ToolSpec[]{
  return[
    {name:'get_product_organisations',staffOnly:true,readOnly:true,
      description:'Read bounded native SAP plant, plant-sales, sales-delivery and tax views for one exact source product. An empty view remains empty; no plant, supplier, stock or operational readiness is inferred.',
      inputSchema:{type:'object',additionalProperties:false,required:['productId'],properties:{productId:key(40)}},
      async run(args){
        const service=sapService(env,'PRODUCT'),productId=text(args.productId,'SAP product ID',40),predicates=[{field:'Product',value:productId}];
        const material=await client.list(service,'A_Product',{fields:['Product','BaseUnit'],predicates,limit:2});
        if(material.more||material.records.length!==1)throw new ToolError('not_found','No unique exact native SAP material exists for these organisational views.');
        const output:Rec={};
        for(const[name,entity,fields]of [
          ['plants','A_ProductPlant',['Product','Plant','AvailabilityCheckType','ProfitCenter','MRPType','MRPResponsible','ProcurementType']],
          ['plantSales','A_ProductPlantSales',['Product','Plant','LoadingGroup','AvailabilityCheckType']],
          ['supplyPlanning','A_ProductSupplyPlanning',['Product','Plant','LotSizingProcedure','MRPType','MRPResponsible','ProcurementType']],
          ['salesAreas','A_ProductSalesDelivery',['Product','ProductSalesOrg','ProductDistributionChnl','SupplyingPlant','AccountDetnProductGroup','ItemCategoryGroup','SalesMeasureUnit']],
          ['taxes','A_ProductSalesTax',['Product','Country','TaxCategory','TaxClassification']],
        ]as const){const answer=await client.list(service,entity,{fields:[...fields],predicates,limit:50});output[name]={records:answer.records,more:answer.more};}
        return{record:{productId:material.records[0].Product,baseUnit:material.records[0].BaseUnit,...output},source:'sap-s4hana',sample:false};
      }},
    {name:'extend_product_organisations',staffOnly:true,readOnly:false,
      description:'Add exactly approved SAP plant, shipping/sales-area and tax views to an existing source material using explicit source organisational settings. No weight/dimension/volume, inventory, price, valuation, supplier or purchasing data is created. Matching views reconcile; different existing views block without overwrite. Does not assert order/invoice readiness.',
      inputSchema:{type:'object',additionalProperties:false,required:['productId','baseUnit','plant','availabilityCheckType','profitCenter','mrpType','mrpController','lotSizingProcedure','procurementType','loadingGroup','salesOrganization','distributionChannel','itemCategoryGroup','accountDeterminationGroup','salesUnit','taxes'],properties:{productId:key(40),baseUnit:key(3),plant:key(4),availabilityCheckType:key(2),profitCenter:key(10),mrpType:key(2),mrpController:key(3),lotSizingProcedure:key(2),procurementType:key(1),loadingGroup:key(4),salesOrganization:key(4),distributionChannel:key(2),itemCategoryGroup:key(4),accountDeterminationGroup:key(2),salesUnit:key(3),taxes:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['country','category','classification'],properties:{country:key(3),category:key(4),classification:key(1)}}}}},
      async run(args,execution){
        if(!execution?.actionId||!execution.tenantId||!execution.environmentId||!execution.principalId||!execution.releaseChecksum)throw new ToolError('not_authorised','An exact SAP material organisation approval is required.');
        const service=sapService(env,'PRODUCT'),product=text(args.productId,'SAP material ID',40),baseUnit=text(args.baseUnit,'existing base unit',3),plant=text(args.plant,'plant',4);
        const plantView={Product:product,Plant:plant,AvailabilityCheckType:text(args.availabilityCheckType,'availability check type',2),ProfitCenter:text(args.profitCenter,'profit centre',10),MRPType:text(args.mrpType,'MRP type',2),MRPResponsible:text(args.mrpController,'MRP controller',3),ProcurementType:text(args.procurementType,'procurement type',1)};
        const plantSales={Product:product,Plant:plant,LoadingGroup:text(args.loadingGroup,'loading group',4),AvailabilityCheckType:plantView.AvailabilityCheckType};
        const supplyPlanning={Product:product,Plant:plant,LotSizingProcedure:text(args.lotSizingProcedure,'lot-sizing procedure',2),MRPType:plantView.MRPType,MRPResponsible:plantView.MRPResponsible,ProcurementType:plantView.ProcurementType};
        const salesView={Product:product,ProductSalesOrg:text(args.salesOrganization,'sales organisation',4),ProductDistributionChnl:text(args.distributionChannel,'distribution channel',2),SupplyingPlant:plant,AccountDetnProductGroup:text(args.accountDeterminationGroup,'product account determination group',2),ItemCategoryGroup:text(args.itemCategoryGroup,'item category group',4),SalesMeasureUnit:text(args.salesUnit,'sales unit',3)};
        if(!Array.isArray(args.taxes)||!args.taxes.length||args.taxes.length>20)throw new ToolError('invalid_arguments','Explicit source tax configuration is required.');
        const taxes=args.taxes.map((row:Rec)=>({Product:product,Country:text(row.country,'source tax country',3),TaxCategory:text(row.category,'source tax category',4),TaxClassification:text(row.classification,'source tax classification',1)}));
        if(new Set(taxes.map(row=>`${row.Country}:${row.TaxCategory}`)).size!==taxes.length)throw new ToolError('invalid_arguments','Source tax keys must be distinct.');
        const root=await client.list(service,'A_Product',{fields:['Product','BaseUnit'],predicates:[{field:'Product',value:product}],limit:2});
        if(root.more||root.records.length!==1||root.records[0].BaseUnit!==baseUnit)throw new ToolError('conflict','The exact SAP base material and approved unit must exist before organisational extension.');
        const views:Array<{entity:string;keys:string[];expected:Rec;body?:Rec}>=[{entity:'A_ProductPlant',keys:['Product','Plant'],expected:plantView,body:{...plantView,to_ProductSupplyPlanning:supplyPlanning}},{entity:'A_ProductSupplyPlanning',keys:['Product','Plant'],expected:supplyPlanning},{entity:'A_ProductPlantSales',keys:['Product','Plant'],expected:plantSales},...taxes.map(expected=>({entity:'A_ProductSalesTax',keys:['Product','Country','TaxCategory'],expected})),{entity:'A_ProductSalesDelivery',keys:['Product','ProductSalesOrg','ProductDistributionChnl'],expected:salesView}];
        const initialisations=new Set<string>();
        const read=async(view:typeof views[number])=>{
          const found=await client.list(service,view.entity,{fields:Object.keys(view.expected),predicates:view.keys.map(field=>({field,value:(view.expected as Rec)[field]})),limit:2});
          if(!found.records.length)return false;
          // SAP creates an empty plant-sales view with a new plant. Complete
          // only its blank loading group via the versioned V4 ETag API. A
          // nonempty/different value still blocks; no wildcard update exists.
          if(!found.more&&found.records.length===1&&view.entity==='A_ProductPlantSales'&&found.records[0].LoadingGroup===''&&exact(found.records[0],Object.fromEntries(Object.entries(view.expected).filter(([field])=>field!=='LoadingGroup')))){
            initialisations.add(view.entity);return false;
          }
          if(found.more||found.records.length!==1||!exact(found.records[0],view.expected))throw new ToolError('conflict','An existing SAP organisational view differs from the reviewed settings; no overwrite was attempted.');
          return true;
        };
        const present=[];for(const view of views)present.push(await read(view));
        let createdViews=0,reconciledViews=0,updatedViews=0;
        for(let index=0;index<views.length;index++){
          const view=views[index];
          if(present[index]||await read(view))continue;
          if(initialisations.has(view.entity)){
            try{await client.patch(sapService(env,'PRODUCT_V4'),'ProductPlantSales',{Product:product,Plant:plant},{LoadingGroup:''},{LoadingGroup:plantSales.LoadingGroup});}
            catch(error){try{if(await read(view)){reconciledViews++;continue;}}catch{}throw error;}
            if(!await read(view))throw new ToolError('receipt_unavailable','SAP did not confirm the ETag-protected loading-group initialisation.');
            updatedViews++;continue;
          }
          try{await client.create(service,view.entity,view.body||view.expected);}catch(error){try{if(await read(view)){reconciledViews++;continue;}}catch{}throw error;}
          if(!await read(view))throw new ToolError('receipt_unavailable','SAP material extension has no exact native view receipt; reconcile before retrying.');
          createdViews++;
        }
        return{record:{productId:product,baseUnit,plant,salesOrganization:salesView.ProductSalesOrg,distributionChannel:salesView.ProductDistributionChnl,salesUnit:salesView.SalesMeasureUnit},source:'sap-s4hana',sample:false,sourceReadbackVerified:true,createdViews,updatedViews,reconciledViews,alreadyPresent:present.filter(Boolean).length,operationalReadinessAsserted:false};
      }},
  ];
}

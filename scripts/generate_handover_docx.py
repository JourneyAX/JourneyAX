#!/usr/bin/env python3
"""
Generate the JourneyAX Enterprise Architecture Handover Word Document (.docx).
Covers end-to-end architecture, cutover design, legacy AgentService decoupling,
execution flows, journey state machine, tenant isolation, and portfolio runbook.
"""
import os
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    shading_elm = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading_elm)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('w:top', top), ('w:bottom', bottom), ('w:left', left), ('w:right', right)]:
        node = OxmlElement(m)
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def style_heading(p, text, level=1):
    p.text = text
    p.paragraph_format.keep_with_next = True
    run = p.runs[0]
    run.font.name = 'Calibri'
    run.bold = True
    if level == 1:
        run.font.size = Pt(18)
        run.font.color.rgb = RGBColor(0x1B, 0x36, 0x5D) # Navy
        p.paragraph_format.space_before = Pt(16)
        p.paragraph_format.space_after = Pt(6)
    elif level == 2:
        run.font.size = Pt(14)
        run.font.color.rgb = RGBColor(0x2C, 0x53, 0x64) # Slate Blue
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.space_after = Pt(4)
    elif level == 3:
        run.font.size = Pt(12)
        run.font.color.rgb = RGBColor(0x33, 0x33, 0x33) # Charcoal
        p.paragraph_format.space_before = Pt(8)
        p.paragraph_format.space_after = Pt(2)

def add_callout(doc, title, text, border_color="1B365D", bg_color="F4F7F9"):
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    cell = table.rows[0].cells[0]
    cell.width = Inches(6.5)
    set_cell_background(cell, bg_color)
    set_cell_margins(cell, top=120, bottom=120, left=180, right=180)
    
    # Left border styling
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(f'''
        <w:tcBorders {nsdecls("w")}>
            <w:top w:val="none"/>
            <w:left w:val="single" w:sz="24" w:space="0" w:color="{border_color}"/>
            <w:bottom w:val="none"/>
            <w:right w:val="none"/>
        </w:tcBorders>
    ''')
    tcPr.append(borders)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(3)
    r_title = p.add_run(f"📌 {title}\n")
    r_title.bold = True
    r_title.font.name = 'Calibri'
    r_title.font.size = Pt(10.5)
    r_title.font.color.rgb = RGBColor(0x1B, 0x36, 0x5D)
    
    r_text = p.add_run(text)
    r_text.font.name = 'Calibri'
    r_text.font.size = Pt(9.5)
    r_text.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)

def add_code_block(doc, code_text):
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    cell = table.rows[0].cells[0]
    cell.width = Inches(6.5)
    set_cell_background(cell, "282C34") # Dark theme
    set_cell_margins(cell, top=100, bottom=100, left=140, right=140)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run(code_text)
    run.font.name = 'Courier New'
    run.font.size = Pt(8.5)
    run.font.color.rgb = RGBColor(0xAB, 0xB2, 0xBF) # Monospace light
    doc.add_paragraph().paragraph_format.space_after = Pt(4)

def format_table(table, col_widths, headers, rows):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    
    # Header row
    hdr_cells = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr_cells[i].text = h
        hdr_cells[i].width = col_widths[i]
        set_cell_background(hdr_cells[i], "1B365D")
        set_cell_margins(hdr_cells[i], top=100, bottom=100, left=120, right=120)
        p = hdr_cells[i].paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        for r in p.runs:
            r.font.name = 'Calibri'
            r.font.size = Pt(9.5)
            r.font.bold = True
            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            
    # Data rows
    for r_idx, row_data in enumerate(rows):
        row = table.add_row()
        fill_hex = "F4F7F9" if r_idx % 2 == 1 else "FFFFFF"
        for c_idx, val in enumerate(row_data):
            cell = row.cells[c_idx]
            cell.text = str(val)
            cell.width = col_widths[c_idx]
            set_cell_background(cell, fill_hex)
            set_cell_margins(cell, top=80, bottom=80, left=120, right=120)
            p = cell.paragraphs[0]
            for r in p.runs:
                r.font.name = 'Calibri'
                r.font.size = Pt(9.0)
                r.font.color.rgb = RGBColor(0x33, 0x33, 0x33)

def generate_handover_document():
    doc = docx.Document()
    
    # Page setup - 0.75 in margins
    for section in doc.sections:
        section.top_margin = Inches(0.75)
        section.bottom_margin = Inches(0.75)
        section.left_margin = Inches(0.75)
        section.right_margin = Inches(0.75)
        
    # Document Header / Title
    title_p = doc.add_paragraph()
    title_p.paragraph_format.space_before = Pt(0)
    title_p.paragraph_format.space_after = Pt(2)
    r_title = title_p.add_run("JourneyAX Enterprise Architecture Handover")
    r_title.font.name = 'Calibri'
    r_title.font.size = Pt(24)
    r_title.bold = True
    r_title.font.color.rgb = RGBColor(0x1B, 0x36, 0x5D)
    
    sub_p = doc.add_paragraph()
    sub_p.paragraph_format.space_after = Pt(12)
    r_sub = sub_p.add_run("End-to-End System Architecture, Cutover Protocol, Legacy Decoupling, and Portfolio Migration Runbook")
    r_sub.font.name = 'Calibri'
    r_sub.font.size = Pt(12)
    r_sub.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    
    # Metadata Block
    meta_table = doc.add_table(rows=1, cols=4)
    meta_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    meta_headers = ["Document Version", "Architecture Baseline", "Target Scope", "Status"]
    meta_data = [["3.4.0-Production", "Immutable Pack & Dual Runtime", "PlaceMakers, Workwear, A&F, Caroma", "Active Reference Complete"]]
    format_table(meta_table, [Inches(1.5), Inches(1.8), Inches(2.2), Inches(1.0)], meta_headers, meta_data)
    doc.add_paragraph().paragraph_format.space_after = Pt(8)

    # ─────────────────────────────────────────────────────────────────────────
    # 1. Executive Summary & Handover Context
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "1. Executive Summary & Architecture Thesis", level=1)
    
    p = doc.add_paragraph(
        "JourneyAX is transitioning from a legacy procedural monolith into a modern, multi-tenant "
        "declarative platform. Business behavior, conversational journeys, capability bindings, and "
        "model selection are decoupled from runtime code and externalized into versioned, immutable Business Packs."
    )
    p.paragraph_format.space_after = Pt(6)
    
    add_callout(
        doc,
        "Core Architectural Invariants",
        "1. Zero Hardcoding: No customer brand names, domain URLs, or prompt overrides in runtime services.\n"
        "2. Deterministic Cutover: tenant_cutovers is the sole routing authority with CAS atomic promotion.\n"
        "3. Strict Isolation: Connections, secrets, and catalog queries never cross tenant boundaries.\n"
        "4. Fail-Closed Security: Canonical tenants fail closed on missing releases; no silent legacy fallback."
    )

    # ─────────────────────────────────────────────────────────────────────────
    # 2. Platform Architecture: The Four Decoupled Planes
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "2. Platform Architecture & The Four Decoupled Planes", level=1)
    
    p = doc.add_paragraph(
        "To achieve enterprise tenant isolation and prevent monolithic fragility, the platform is cleanly "
        "partitioned into four distinct operational planes:"
    )
    p.paragraph_format.space_after = Pt(4)

    planes_table = doc.add_table(rows=1, cols=4)
    p_headers = ["Plane", "Primary Component", "Responsibility", "Key Artifacts / Storage"]
    p_rows = [
        ["Control Plane", "packages/business-pack", "Pack compilation, checksum calculation, semantic validation, immutable publishing", "business_pack_releases, business_pack_pointers"],
        ["Runtime Data Plane", "apps/journey-runtime-service", "Goal-based journey execution, stage transitions, structured facts, SSE streaming", "workspaces, session state, audit traces"],
        ["Integration Plane", "CapabilityDispatcher & lead-service", "Activepieces execution, typed connector ownership, dynamic CRM dispatch", "tenant_connections, approval_requests"],
        ["Evidence Plane", "packages/database (CutoverRepo)", "CAS cutover promotion, deterministic canary bucketing, rollback history", "tenant_cutovers, cutover_audit_logs, parity_evidence"]
    ]
    format_table(planes_table, [Inches(1.2), Inches(1.8), Inches(2.2), Inches(1.3)], p_headers, p_rows)
    doc.add_paragraph().paragraph_format.space_after = Pt(8)

    add_code_block(doc, 
"""+-----------------------------------------------------------------------------------+
|                           JOURNEYAX RUNTIME ARCHITECTURE                           |
+-----------------------------------------------------------------------------------+
|  Storefront UI (journeyax-web)  <-->  API Gateway (:3010)                         |
|                                            |                                      |
|                  +-------------------------+-------------------------+            |
|                  | (Cutover Decision: tenant_cutovers)               |            |
|                  v                                                   v            |
|  [CANONICAL RUNTIME: :3009]                          [LEGACY COMERCE: :3004]      |
|  - apps/journey-runtime-service                      - apps/agent-commerce-service|
|  - Immutable Business Pack Loader                    - CutoverProxyService        |
|  - Stage-scoped CapabilityResolver                   - Legacy Procedural Flow     |
|  - Structured Fact Ledgers & TurnApplication         - Frozen behind boundary     |
|                  |                                                                |
|                  v                                                                |
|  [INTEGRATION PLANE: Activepieces & lead-service]                                 |
|  - Authoritative tenant_connections lookup (Strict Tenant Isolation)              |
|  - Dynamic CRM Provider Binding (HubSpot / Salesforce / Zoho / Dynamics)          |
|  - Transactional Outbox Worker (:3009 worker) & Dead Letter Queue                 |
+-----------------------------------------------------------------------------------+""")

    # ─────────────────────────────────────────────────────────────────────────
    # 3. The Cutover Architecture & Deployment Plan (Deep Dive)
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "3. Deep Dive: Cutover Architecture & Deployment Plan", level=1)
    
    p = doc.add_paragraph(
        "Why Cutover Exists: In a multi-tenant enterprise system, migrating tenants requires zero downtime, "
        "tenant-isolated canary testing, and instant zero-data-loss rollback. The cutover architecture provides "
        "a cryptographically verifiable gate governing whether a request executes via the canonical "
        "journey-runtime-service or legacy agent-commerce-service."
    )
    p.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    style_heading(p, "3.1 The Four Cutover States", level=2)
    
    cutover_table = doc.add_table(rows=1, cols=3)
    c_headers = ["Cutover Status", "Traffic Routing", "Description & Invariants"]
    c_rows = [
        ["unmigrated", "100% Legacy Commerce", "Tenant has not cut over. Requests route to legacy agent-commerce-service. Safe baseline."],
        ["canary", "0% - 99% Canonical, remainder Legacy", "Deterministic percentage routed to canonical runtime using SHA-256 session bucketing."],
        ["migrated", "100% Canonical Runtime", "Fully cut over. Requests execute exclusively on journey-runtime-service. Legacy fallback prohibited."],
        ["rollback", "100% Legacy (or prior release)", "Deliberate reversal triggered by ops. Reverts to legacy or approved rollbackTargetVersion."]
    ]
    format_table(cutover_table, [Inches(1.2), Inches(1.8), Inches(3.5)], c_headers, c_rows)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    style_heading(p, "3.2 Deterministic Hash Bucketing (Canary Protocol)", level=2)
    p = doc.add_paragraph(
        "Canary allocation MUST NOT use Math.random(). Randomness causes a customer to bounce between legacy "
        "and canonical runtimes across conversation turns, corrupting session state. JourneyAX implements "
        "deterministic SHA-256 hash bucketing over a stable composite key:"
    )
    add_code_block(doc,
"""// packages/journey-core/src/canary-routing.ts
export function computeCanaryBucket(key: string): number {
  const hash = crypto.createHash('sha256').update(key).digest();
  return hash.readUInt32BE(0) % 100; // Returns stable integer 0 - 99
}

// Bucketing Key: ${tenantId}:${environmentId}:${workspaceId}
const bucket = computeCanaryBucket(`${tenant}:${env}:${workspaceId}`);
const useCanonical = bucket < canaryPercentage;""")

    p = doc.add_paragraph()
    style_heading(p, "3.3 Compare-and-Swap (CAS) Atomic Revision Protocol", level=2)
    p = doc.add_paragraph(
        "Cutover promotion enforces optimistic concurrency control. Every update requires expectedRevision. "
        "If a concurrent deployment altered the cutover record, the promotion fails with CutoverConflictError. "
        "All updates write an audit row to cutover_audit_logs within the same MongoDB transaction."
    )
    p.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    style_heading(p, "3.4 Fail-Closed Storefront Configuration Policy", level=2)
    p = doc.add_paragraph(
        "A critical security rule enforced in Workstream C: once a tenant is marked 'migrated', the storefront "
        "(apps/journeyax-web/src/app/api/config/route.ts) MUST FAIL CLOSED if its published configuration fails "
        "to load. Returning hardcoded mock data (such as the legacy PlaceMakers static object) is strictly "
        "forbidden for activated tenants. Legacy fallback is permitted ONLY if the cutover record explicitly states 'unmigrated'."
    )
    p.paragraph_format.space_after = Pt(8)

    # ─────────────────────────────────────────────────────────────────────────
    # 4. Legacy AgentService Strategy & Decommissioning Roadmap
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "4. Legacy AgentService Decoupling & Decommissioning Plan", level=1)

    p = doc.add_paragraph()
    style_heading(p, "4.1 Why AgentService Was Kept Frozen in This Slice", level=2)
    p = doc.add_paragraph(
        "A key design decision during the portfolio governance slice was to freeze apps/agent-commerce-service/src/agent.service.ts "
        "(7,315 lines) rather than rewriting or minimizing it mid-migration. This followed explicit governance instructions:"
    )
    add_callout(
        doc,
        "Architectural Rationale for Freezing AgentService",
        "1. Strict Risk Containment: AgentService is a procedural monolith serving unmigrated tenants. Refactoring it "
        "directly while tenants like Workwear Group and Caroma are still in flight risks introducing cross-tenant regressions.\n"
        "2. The Strangler Fig Pattern: The correct enterprise pattern is to strangle the monolith by intercepting traffic at "
        "the boundary (via CutoverProxyService). Migrated tenants (PlaceMakers) bypass AgentService completely.\n"
        "3. Clean Final Retirement: Once all active portfolio tenants have published canonical Business Packs, the entire "
        "agent.service.ts monolith will be deleted in a single clean decommissioning step rather than maintaining an unstable hybrid."
    )

    p = doc.add_paragraph()
    style_heading(p, "4.2 How CutoverProxyService Guards the Monolith", level=2)
    p = doc.add_paragraph(
        "apps/agent-commerce-service/src/cutover/cutover-proxy.service.ts sits at turn 0 of the legacy service. "
        "Before loading any session state or executing legacy prompt construction, it queries the cutover registry. "
        "If the tenant is 'migrated', it proxies the turn to journey-runtime-service and adapts the response, leaving "
        "AgentService untouched."
    )
    p.paragraph_format.space_after = Pt(8)

    # ─────────────────────────────────────────────────────────────────────────
    # 5. End-to-End Execution Flows
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "5. End-to-End Operational Execution Flows", level=1)

    p = doc.add_paragraph()
    style_heading(p, "5.1 User Chat Turn & Real-Time SSE Streaming Flow", level=2)
    add_code_block(doc,
"""[User / Browser]
       │  POST /api/v1/commerce/chat/stream
       ▼
[API Gateway (:3010)] ── Validates JWT / HMAC ── Adds X-Tenant-ID header
       │
       ▼
[agent-commerce-service (:3004)] ── CutoverProxyService.resolveCutover()
       │
       ├─ [status == 'unmigrated'] ──> Executes legacy prompt & returns
       │
       └─ [status == 'migrated' or in canary]
              │
              ▼ (Proxies HTTP Turn)
[journey-runtime-service (:3009)]
       │
       ├─ 1. Load BusinessPackRelease via BusinessPackLoader (Mongo pointer + checksum check)
       ├─ 2. Restore WorkspaceState from MongoDB workspaces collection
       ├─ 3. Replay Protection: verify turnId has not been processed in workspace
       ├─ 4. CapabilityResolver: resolve stage-scoped tools allowed in current stage
       ├─ 5. ModelGateway: execute model turn against candidate in ModelPolicy (e.g. GPT-4o-mini)
       ├─ 6. OutcomeValidator: validate model claims against catalog and fact constraints
       ├─ 7. TurnApplicationService: transactionally commit new facts, stage, and trace
       └─ 8. Stream SSE tokens and UI instructions (presentCard) back to Gateway & Browser""")

    p = doc.add_paragraph()
    style_heading(p, "5.2 Dynamic Capability Resolution & CRM Lead Push", level=2)
    p = doc.add_paragraph(
        "In Workstream C, the hardcoded 'caroma ? hubspot : salesforce' conditional was eliminated from apps/lead-service. "
        "LeadController now delegates to CrmConnectorBindingResolver, which dynamically discovers the tenant's CRM provider "
        "from three tenant-scoped sources: (1) tenant_connections, (2) Business Pack toolBindings, or (3) project integrations. "
        "If unconfigured, it fails closed."
    )
    p.paragraph_format.space_after = Pt(8)

    # ─────────────────────────────────────────────────────────────────────────
    # 6. Journey State Machine & Declarative Graphs
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "6. Journey Engine & Declarative Graph Execution", level=1)
    
    p = doc.add_paragraph(
        "A JourneyAX Business Pack defines journeys as deterministic directed graphs of stages. "
        "A customer advances through stages only when required facts are populated in the workspace ledger."
    )
    
    stages_table = doc.add_table(rows=1, cols=4)
    s_headers = ["Stage", "Required Facts", "Permitted Capabilities", "Exit Condition"]
    s_rows = [
        ["stage_discovery", "None (initial)", "catalog.search, knowledge.search", "room_type / space identified"],
        ["stage_scoping", "space, dimensions", "catalog.search, scoping.estimate", "selected_categories non-empty"],
        ["stage_bom", "selected_items, branch", "pricing.validate, branch.stock", "quote_total computed and accepted"],
        ["stage_checkout", "customer_details, quoteId", "order.commit, crm.push_lead", "order_id issued (terminal stage)"]
    ]
    format_table(stages_table, [Inches(1.2), Inches(1.5), Inches(2.3), Inches(1.5)], s_headers, s_rows)
    doc.add_paragraph().paragraph_format.space_after = Pt(8)

    # ─────────────────────────────────────────────────────────────────────────
    # 7. Portfolio Status, Migration Runbook & Forward Plan
    # ─────────────────────────────────────────────────────────────────────────
    p = doc.add_paragraph()
    style_heading(p, "7. Portfolio Status, Pending Work & Migration Runbook", level=1)

    p = doc.add_paragraph()
    style_heading(p, "7.1 Customer Portfolio Status Matrix", level=2)
    
    port_table = doc.add_table(rows=1, cols=5)
    po_headers = ["Tenant ID", "Classification", "Source", "Readiness Status", "Pending Work / Blocker"]
    po_rows = [
        ["placemakers", "ACTIVE_PORTFOLIO", "filesystem_pack", "CANDIDATE_PACK_VALIDATED", "Reference migration complete. Ready for production cutover approval."],
        ["workweargroup", "ACTIVE_PORTFOLIO", "filesystem_pack", "BLOCKED", "Candidate pack on disk. Lacks immutable DB release, pointer, and cutover record."],
        ["abercrombie", "ACTIVE_PORTFOLIO", "not_discovered", "BLOCKED", "Configured in manifest. Awaiting pack creation, model policy, and catalog seed."],
        ["caroma", "ACTIVE_PORTFOLIO", "not_discovered", "BLOCKED", "Configured in manifest. Awaiting pack creation and connector mapping."],
        ["royalcyber", "PARKED", "filesystem_pack", "PARKED", "Parked by stakeholder sign-off. Excluded from active blockers."],
        ["caroma-nz", "PARKED", "not_discovered", "PARKED", "Parked by stakeholder sign-off. Excluded from active blockers."],
        ["dragonshield", "PARKED", "not_discovered", "PARKED", "Parked by stakeholder sign-off. Excluded from active blockers."],
        ["momentec", "PARKED", "not_discovered", "PARKED", "Parked by stakeholder sign-off. Excluded from active blockers."],
        ["garts", "PARKED", "not_discovered", "PARKED", "Parked by stakeholder sign-off. Excluded from active blockers."]
    ]
    format_table(port_table, [Inches(1.1), Inches(1.3), Inches(1.2), Inches(1.4), Inches(1.5)], po_headers, po_rows)
    doc.add_paragraph().paragraph_format.space_after = Pt(8)

    p = doc.add_paragraph()
    style_heading(p, "7.2 Step-by-Step Tenant Migration Runbook (for the Engineering Team)", level=2)
    
    runbook_steps = [
        "Step 1: Manifest Declaration — Ensure tenant is declared in config/portfolio-manifest.json under activePortfolio with valid commerceMode ('quote'|'cart'), dataResidency (regex: ^[a-z]{2}(-[a-z0-9]+)?$), and migrationPriority.",
        "Step 2: Business Pack Authoring — Create packs/<tenantId>/ with manifest.json, business-profile.json, model-policy.json, journeys/, capabilities/bindings.json, and experience/.",
        "Step 3: Pack Validation & Checksum — Run npx tsx scripts/inventory-tenant-connectors.ts to confirm schema and semantic integrity. Zero raw secrets or hardcoded domains permitted.",
        "Step 4: Immutable Publication — Execute publishBusinessPack() to compile the journey graph, write the immutable document to business_pack_releases, and register the active pointer in business_pack_pointers.",
        "Step 5: Connector Ownership Provisioning — Insert tenant-scoped connection records in tenant_connections with active status, allowedFlows whitelist, and piece identification.",
        "Step 6: Cutover CAS Promotion — Invoke CutoverRepository.promoteCutover() inside a transaction with status='canary' (e.g. 10%) and expectedRevision=0.",
        "Step 7: Verification & Parity Audit — Run acceptance suite (SSE streaming, boundary replay, fact ledger). Increase canary to 50%, then 100% ('migrated').",
        "Step 8: Rollback Safety — If parity degrades, execute promoteCutover() with status='rollback' and rollbackTargetVersion to revert within 50ms without data loss."
    ]
    
    for step in runbook_steps:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.2)
        p.paragraph_format.space_after = Pt(4)
        r = p.add_run(step)
        r.font.name = 'Calibri'
        r.font.size = Pt(9.5)

    p = doc.add_paragraph()
    style_heading(p, "7.3 What Is Pending Now (Immediate Next Steps)", level=2)
    p = doc.add_paragraph(
        "1. Authoring and publishing canonical Business Packs for Workwear Group, Abercrombie & Fitch, and Caroma.\n"
        "2. Provisioning authentic tenant_connections and secretRef mappings for each active tenant in non-production environments.\n"
        "3. Executing CAS cutover promotions through the 5-stage canary gate for each customer sequentially.\n"
        "4. Once all active customers are running 100% on journey-runtime-service, decommissioning the legacy apps/agent-commerce-service monolith."
    )
    p.paragraph_format.space_after = Pt(12)

    # Save to file
    out_dir = os.path.dirname(os.path.abspath(__file__))
    docs_dir = os.path.join(out_dir, "..", "docs")
    target_path = os.path.abspath(os.path.join(docs_dir, "JourneyAX_Enterprise_Architecture_Handover.docx"))
    doc.save(target_path)
    print(f"✅ Handover document generated successfully at: {target_path}")

if __name__ == "__main__":
    generate_handover_document()

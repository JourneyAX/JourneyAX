/** Tenant-aware artwork approval transport. */
export async function artworkCall(tenantId: string, path: string, body: unknown): Promise<any> {
  const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
  const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function requestArtwork(tenantId: string, sessionId: string, rawArgs: string): Promise<unknown> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  const policy = 'This business does not supply or recreate school, club or league marks — they are trademarked. Ask the customer to upload their own artwork, and to confirm they are entitled to use it.';
  try { const onFile = await artworkCall(tenantId, 'artwork/list', { sessionId }); return { uploadRequired: true, reason: args.reason || 'Artwork is needed before this order can be proofed.', placement: args.placement, onFile: onFile.items || [], approvedCount: onFile.approvedCount || 0, policy }; }
  catch { return { uploadRequired: true, onFile: [], approvedCount: 0, policy }; }
}

export async function checkArtworkApproval(tenantId: string, sessionId: string): Promise<unknown> {
  try { const gate = await artworkCall(tenantId, 'artwork/gate', { sessionId }); return { ...gate, instruction: gate.clear ? 'Artwork is approved. It is safe to proceed to a final quote.' : 'Do NOT present this as production-ready. Tell the customer exactly what is outstanding and ask them to approve the proof. You cannot approve it for them.' }; }
  catch { return { clear: false, reason: 'Could not verify artwork approval — treat as NOT approved and say so.' }; }
}

export async function checkReviewStatus(tenantId: string, sessionId: string): Promise<any> {
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/reviews?sessionId=${encodeURIComponent(sessionId)}`, { headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) return { ok: false, message: 'Could not check the review status.' };
    const body: any = await response.json(); const latest = (body.reviews || []).slice(-1)[0];
    if (!latest) return { ok: true, status: 'none', instruction: 'No design has been submitted for review yet. Submit one with submitForReview once the customer is happy.' };
    const instructions: Record<string, string> = { pending_artist: 'Still with our artist for review — tell the customer honestly it is being checked; do NOT say it is ready.', changes_requested: `Our artist asked for changes${latest.artist?.notes ? ` (${latest.artist.notes})` : ''} — relay this and help the customer revise.`, artist_approved: 'The artist has APPROVED the proof. Invite the customer to AGREE to it so it can go to print — you cannot agree for them.', customer_agreed: 'The customer has agreed; it is being finalised for print.', ready_for_print: 'Approved by artist AND agreed by the customer — it is READY FOR PRINT. Proceed to quote/checkout.' };
    return { ok: true, jobId: latest.jobId, status: latest.status, kind: latest.kind, instruction: instructions[latest.status] || 'Report the status honestly.' };
  } catch (err) { console.error('[AgentService] checkReviewStatus error:', err); return { ok: false, message: 'Could not check the review status.' }; }
}

export async function designableAlternatives(
  tenantId: string, sku: string, limit = 4, likeName?: string,
): Promise<{ sku: string; name?: string; price?: number; image?: string }[]> {
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const headers = { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                      'X-Internal-Key': process.env.INTERNAL_API_KEY || '' };

    // The failed style's own name describes what was wanted; product-service
    // resolves it from the sku so the name never has to travel through here.
    // Except when it CANNOT: an item offered from a text chunk has no product
    // row, so its code resolves to nothing and the lookup came back empty —
    // which sent the caller down the "keep the unprovable items" path. The
    // item's display name is the fallback description of what was wanted.
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/designable`, {
      method: 'POST', headers,
      body: JSON.stringify(sku ? { likeSku: sku, limit } : { like: likeName || '', limit }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return ((await res.json())?.items || [])
      .map((i: any) => ({ sku: i.sku, name: i.name, price: i.price, image: i.image }));
  } catch {
    return [];
  }
}


export async function validateDesign(tenantId: string, call: any, configuratorType?: string): Promise<Record<string, unknown>> {
  if (call?.function?.name !== 'showConfigurator') return { success: true };
  // A candy configurator has no server-side mesh to render — the disc is
  // composited client-side from config. Running the garment renderer here would
  // return not-renderable and make the agent apologise over a panel that opened
  // fine. The design step itself enforces the print rules (shells, 2×9 text),
  // so the open IS the success.
  if (configuratorType === 'candy') {
    return { success: true, note: 'The candy designer is open — the customer is personalising it now. Do NOT say there was a problem; invite them to pick colours and a message, then build the quote.' };
  }
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { success: true }; }
  if (!args.sku) return { success: true, note: 'No style specified.' };

  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
      body: JSON.stringify({
        style: args.sku,
        designLine: args.designLine,
        colours: [args.baseColor, args.accentColor].filter(Boolean),
        text: { teamName: args.name, number: args.number },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return {
        success: false,
        previewUnavailable: true,
        instruction: 'The configurator could not verify this style. Do not open a design preview or claim it is customisable; show verified products instead.',
      };
    }
    const r: any = await res.json();

    const available: string[] = (r.designLines || []).map((d: any) => d.slug);
    const rejected: string[] = r.rejectedColours || [];
    const out: Record<string, unknown> = { success: !!r.renderable };
    let corrected = false;

    // A design line the style does not offer leaves its layer hidden, so the
    // garment renders blank. Substituting silently would be its own lie, so the
    // correction is reported back and the model must mention it.
    if (args.designLine && available.length
        && !available.includes(String(args.designLine).toLowerCase())) {
      out.designLineRejected = args.designLine;
      out.availableDesignLines = available;
      delete args.designLine;
      corrected = true;
    }
    if (!args.designLine && available.length) {
      /* The renderer no longer ships a blank garment when no design line is
       * named — it applies the style's widest one so the customer's colours are
       * actually visible. Telling the model "no design line was applied" while
       * the panel shows one produces a description that contradicts the screen,
       * which is the failure this whole validation exists to prevent. */
      if (r.appliedDesignLine) {
        out.designLineDefaulted = r.appliedDesignLine;
        out.availableDesignLines = available;
      } else {
        out.designLineMissing = true;
        out.availableDesignLines = available;
      }
    }
    /* Zones that reused a colour because the design has more zones than the
     * customer named. Not an error — but they should be told, so they can pick
     * a distinct colour for each rather than discover the repeat on delivery. */
    if (r.zonesFilledByRepeat) out.zonesReusingAColour = r.zonesFilledByRepeat;

    if (rejected.length) {
      out.coloursNotStocked = rejected;
      // Drop them rather than let Scene7 substitute — an unknown colour renders
      // black, which the customer never asked for.
      for (const key of ['baseColor', 'accentColor']) {
        if (rejected.some((c) => String(args[key] || '').toUpperCase() === c.toUpperCase())) {
          delete args[key]; corrected = true;
        }
      }
    }

    if (!r.renderable) {
      out.previewUnavailable = true;
      out.showingInstead = r.catalogueImage ? 'catalogue photograph' : 'nothing';

      /* Saying "this one cannot be previewed" is honest and useless. The style
       * was almost certainly a STOCK garment — retrieval ranks on text, which
       * cannot tell a made-to-order jersey from a fixed-colourway one, so a
       * custom team request lands on a style that can never wear the team's
       * colours. Offer styles proven designable instead, so the customer is
       * steered to something that works rather than left at a dead end. */
      const alternatives = await designableAlternatives(tenantId, args.sku);
      if (alternatives.length) out.designableAlternatives = alternatives;
    }

    if (corrected) {
      // The note was written BEFORE validation, so it still describes the design
      // the model intended — "in maroon and gold with the center field design".
      // Left alone it becomes the panel's caption and contradicts the garment
      // actually shown, which is the same lie in a different place.
      args.note = 'Some of what you asked for is not available on this style — see the note below.';
      call.function.arguments = JSON.stringify(args);
    }

    out.instruction =
      out.designableAlternatives
        ? 'This style CANNOT be custom-designed — it is a stock garment, so the team colours can never '
          + 'be applied to it. Do not offer to proceed with it and do not apologise for a technical '
          + 'fault. Name one or two of the designable styles listed above and ask which they want.'
        : (out.designLineRejected || out.coloursNotStocked || out.previewUnavailable || out.designLineMissing)
          ? 'Do NOT tell the customer this design is ready. Say plainly what could not be applied and '
            + 'offer them a real alternative from the lists above, then wait for their choice.'
          : out.designLineDefaulted
            ? `The garment on screen is wearing the "${out.designLineDefaulted}" design line, chosen `
              + 'because none was named. Say which design line they are looking at and offer the '
              + 'alternatives above — do NOT say a design line was not applied, because one was.'
            : 'The design rendered as described.';
    return out;
  } catch {
    return {
      success: false,
      previewUnavailable: true,
      instruction: 'The configurator could not verify this style. Do not open a design preview or claim it is customisable; show verified products instead.',
    };
  }
}

/**
 * A confirmed programme's colours (AUG-27).
 *
 * Delegated so the model never states colours from memory: the service decides
 * whether they are confirmed, merely proposed, or unknown, and maps them onto
 * what the brand can actually print.
 */

export async function analyzeDesign(
  tenantId: string,
  image: { imageBase64?: string; imageUrl?: string },
  rawArgs: string,
): Promise<unknown> {
  if (!image?.imageBase64 && !image?.imageUrl) {
    return { ok: false, message: 'No design image is attached to this turn. Ask the customer to upload their design, or describe it so we can generate one.' };
  }
  let sizes: string[] | undefined;
  try { const a = JSON.parse(rawArgs || '{}'); if (Array.isArray(a?.sizes)) sizes = a.sizes; } catch { /* optional */ }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ imageBase64: image.imageBase64, imageUrl: image.imageUrl, sizes }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, message: 'The design analyser is unavailable right now. Try again in a moment.' };
    const j: any = await res.json();
    const a = j?.analysis || {};
    const m = j?.match || {};
    // The matcher wraps each hit as { score, template: {...} } — the style code
    // lives on best.template, not best directly.
    const bestT = m?.best?.template || m?.best;
    // FAITHFUL PROOF (Path A): parametric colour zones cannot reproduce an all-
    // over artwork / logo (Rink Rippers renders as muddy stripes). So when the
    // customer UPLOADED a design and it matched a make-able style, composite their
    // actual artwork onto that style's garment via image-gen — the proof then
    // looks like their design. Best-effort: a failure just omits the proof.
    let proofId: string | null = null;
    if (m?.decision === 'use' && bestT?.parentSku && (image.imageBase64 || image.imageUrl)) {
      try {
        const pr = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ sku: bestT.parentSku, artworkBase64: image.imageBase64, artworkUrl: image.imageUrl }),
          signal: AbortSignal.timeout(90000),
        });
        if (pr.ok) { const pj: any = await pr.json(); proofId = pj?.proofId || null; }
      } catch { /* proof is best-effort */ }
    }
    return {
      ok: true,
      decision: m?.decision || (bestT ? 'use' : 'create'),   // 'use' | 'create'
      design: {
        sport: a.sport, garmentType: a.garmentType, division: a.division,
        colours: a.colors || [], keywords: a.keywords || [],
        elements: a.elements || {},       // { logo, name, number, allOverPattern }
        summary: a.summary,
      },
      // On 'use' → the real style code to hand to showConfigurator.
      template: bestT?.parentSku ? { sku: bestT.parentSku, name: bestT.name, sizes: bestT.sizes } : null,
      // Deterministic configurator config (colours mapped to the palette + text) —
      // the server, not the model, decides how the design renders (colour fix).
      suggestedConfig: j?.suggestedConfig || null,
      // Faithful proof image id (their artwork on our garment) — shown big.
      proofId,
      // A couple of alternates the model can offer if the customer dislikes the top match.
      alternates: (m?.results || []).slice(1, 4)
        .map((r: any) => r?.template || r)
        .filter((t: any) => t?.parentSku)
        .map((t: any) => ({ sku: t.parentSku, name: t.name })),
    };
  } catch (err) {
    console.error('[AgentService] analyzeDesign error:', err);
    return { ok: false, message: 'Could not analyse the design right now.' };
  }
}

/**
 * CDL "design it in chat" (Door A): generate a jersey concept from the
 * customer's brief (nano-banana via product-service), then analyse + match it to
 * a make-able template — the same use/create decision as an upload. The concept
 * image itself never enters the LLM prompt (it's ~1–2MB); we return a short
 * conceptId the panel fetches, plus the decision/design/template the model needs.
 */


export async function generateDesign(tenantId: string, rawArgs: string): Promise<any> {
  let brief = ''; let sizes: string[] | undefined;
  try { const a = JSON.parse(rawArgs || '{}'); brief = String(a?.brief || '').trim(); if (Array.isArray(a?.sizes)) sizes = a.sizes; } catch { /* */ }
  if (!brief) return { ok: false, message: 'Ask the customer to describe the design (colours, team, number, style).' };
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/design`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ brief, sizes }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, message: 'The design generator is busy right now — try again in a moment.' };
    const j: any = await res.json();
    const a = j?.analysis || {};
    const m = j?.match || {};
    const bestT = m?.best?.template || m?.best;
    return {
      ok: true,
      conceptId: j?.conceptId || null,           // panel fetches the concept image by this id
      decision: m?.decision || (bestT ? 'use' : 'create'),
      design: {
        sport: a.sport, garmentType: a.garmentType, division: a.division,
        colours: a.colors || [], keywords: a.keywords || [], elements: a.elements || {}, summary: a.summary,
      },
      template: bestT?.parentSku ? { sku: bestT.parentSku, name: bestT.name, sizes: bestT.sizes } : null,
      suggestedConfig: j?.suggestedConfig || null,
      alternates: (m?.results || []).slice(1, 4).map((r: any) => r?.template || r).filter((t: any) => t?.parentSku).map((t: any) => ({ sku: t.parentSku, name: t.name })),
    };
  } catch (err) {
    console.error('[AgentService] generateDesign error:', err);
    return { ok: false, message: 'Could not generate the design right now.' };
  }
}

/**
 * Coach Team-Order Journey (Step 3): generate up to four FLAT 2D team-jersey
 * views (front/back/left/right) from the accumulated brief, via
 * product-service's `/cdl/flat-views` (same base URL pattern as generateDesign
 * → `/cdl/design`). Unlike generateDesign/analyzeDesign there is no
 * decision/template matching here — this stays 2D-only, no 3D bake, and no
 * catalogue-template lookup. An uploaded team logo attached this turn is
 * threaded through the same way analyzeDesign receives it (`turnImage`),
 * becoming the seed artwork the four views are generated from.
 */


export async function generateTeamDesign(
  tenantId: string,
  image: { imageBase64?: string; imageUrl?: string } | undefined,
  rawArgs: string,
): Promise<any> {
  let brief = ''; let sourceId = ''; let sku = '';
  try {
    const a = JSON.parse(rawArgs || '{}');
    brief = String(a?.brief || '').trim();
    sourceId = String(a?.sourceId || '').trim();
    sku = String(a?.sku || '').trim();
  } catch { /* */ }
  if (!brief && !sourceId && !image?.imageBase64 && !image?.imageUrl) {
    return { ok: false, message: "Ask the coach to describe the team's look (sport, colours, garment, lettering), or attach the team logo." };
  }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/flat-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        brief,
        ...(sourceId ? { sourceId } : {}),
        ...(image?.imageBase64 ? { artworkBase64: image.imageBase64 } : {}),
        ...(image?.imageUrl ? { artworkUrl: image.imageUrl } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, message: 'The team design generator is busy right now — try again in a moment.' };
    const j: any = await res.json();
    if (!j?.ok) return { ok: false, message: j?.message || 'Could not generate the team views right now.' };
    return {
      ok: true,
      frontId: j.frontId, backId: j.backId, leftId: j.leftId, rightId: j.rightId,
      frontError: j.frontError, backError: j.backError, leftError: j.leftError, rightError: j.rightError,
      brief,
      ...(sku ? { sku } : {}),
      instruction: 'The four views (front/back/left/right, whichever generated) are now shown to the coach. Tell them briefly what is shown and invite them to approve or ask for a change. The panel itself offers the "approve, go to roster" step — you do not need another tool call for that.',
    };
  } catch (err) {
    console.error('[AgentService] generateTeamDesign error:', err);
    return { ok: false, message: 'Could not generate the team design right now.' };
  }
}

/** uploadPhotosFor3D is deliberately server-thin: the actual bake happens
 *  CLIENT-SIDE in PhotoUploadDesignPanel once the customer submits their real
 *  photos (POST /api/cdl/bake3d, not this function). This tool's only job is
 *  to hand back an ok:true so the UI dispatch layer opens the upload panel —
 *  mirrors generateTeamDesign's dispatch-then-uiAction shape without the
 *  network round trip generateTeamDesign needs (there is no server-side
 *  generation step here, just a phase switch). */


export async function uploadPhotosFor3D(rawArgs: string): Promise<any> {
  let sku = '';
  try {
    const a = JSON.parse(rawArgs || '{}');
    sku = String(a?.sku || '').trim();
  } catch { /* */ }
  return {
    ok: true,
    ...(sku ? { sku } : {}),
    instruction: 'The real-photo upload panel is now shown to the customer. They will upload up to 4 real photos (front required) of their actual garment and the 3D bake runs when they submit — you do not do anything further here; just tell them briefly the panel is open and to add their photos.',
  };
}

/** CDL: submit the current design for artist review (the production-authority
 *  gate). The artist signs off before anything prints; the agent can never
 *  approve for them. */


export async function submitForReview(tenantId: string, sessionId: string, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  const kind = args?.kind === 'create' ? 'create' : 'use';
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ sessionId, kind, sku: args?.sku, summary: args?.summary, sizes: args?.sizes }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: 'Could not submit for review right now.' };
    const j: any = await res.json();
    return {
      ok: true, jobId: j.jobId, status: j.status, kind,
      instruction: kind === 'create'
        ? 'Submitted as a NEW design. Tell the customer our artist will generate the cut pieces at every size and finalise it, then you will confirm once approved. Do NOT promise a timeline you were not given.'
        : 'Submitted to the artist for a production check. Tell the customer it is with our artist and you will confirm once approved. Do NOT call it production-ready yourself.',
    };
  } catch (err) {
    console.error('[AgentService] submitForReview error:', err);
    return { ok: false, message: 'Could not submit for review right now.' };
  }
}

/**
 * Coach Team-Order Journey (Step 6): submit the team's finished design +
 * roster for artist review — the same lifecycle as submitForReview
 * (POST :projectId/cdl/review, kind 'use'), sourcing sku the same way
 * submitForReview does (a model-supplied or journeyState-known style code).
 *
 * HONEST LIMITATION: the roster and four flat-view ids only ever exist in the
 * BROWSER's journey state — the server-side `journeyState` this function
 * receives (unlike the client's React JourneyState) never accumulates them,
 * so a chat-triggered submit here goes through WITHOUT roster/flatViews on
 * the review record. The reliable, fully-populated path is the "Submit team
 * order" button in ConfiguratorPanel (teamPreview phase), which posts the
 * browser's actual roster + views directly. This tool exists so a coach who
 * says "submit it" in chat still gets a real jobId rather than silence.
 */


export async function submitTeamOrder(tenantId: string, sessionId: string, journeyState: any, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  const sku = String(args?.sku || journeyState?.activeSku || '').trim() || undefined;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ sessionId, kind: 'use', sku, summary: args?.summary }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: 'Could not submit the team order right now.' };
    const j: any = await res.json();
    return {
      ok: true, jobId: j.jobId, status: j.status,
      instruction: 'Submitted the team order to our artist. Tell the coach it is with our artist and you will confirm once approved — do NOT call it production-ready yourself. If the roster or design views look incomplete on the artist side, tell the coach to use the "Submit team order" button on the 3D preview instead, which carries the full roster.',
    };
  } catch (err) {
    console.error('[AgentService] submitTeamOrder error:', err);
    return { ok: false, message: 'Could not submit the team order right now.' };
  }
}

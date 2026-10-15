# Editor handoff: turn the motion cut into a launch film

Use `LAUNCH-CREATIVE-BRIEF.md` as the source of truth for messaging, timing and claims. The MP4 is a moving rough cut. It is not the final cinematic export. Keep all exact labels, logos, charts and UI cards in the edit layer; generative video should make **background motion**, not attempt to write UI text.

## Short motion prompts for image-to-video shots

Use the matching original PNG in `assets/` as the image reference. Generate 4–7 seconds per shot at 16:9. Preserve people, clothing, objects, room, lighting and identity. No speaking faces, lip sync, new products, logos, UI, words, prices or extra people. Use a 3–5% camera move, gentle depth, and natural physical motion only. Retain left-side negative space for the editorial caption overlay.

1. **Building / laundry:** “Subtle cinematic push into a homeowner assessing her laundry renovation. She shifts her attention between material samples and the space, with natural hand and eye movement. Warm daylight breathes gently. Preserve the room geometry and all objects.”
2. **Manufacturing:** “Subtle dolly across a sales engineer and buyer examining a real metal component in a clean industrial facility. Small natural pointing/inspection movement. Preserve the exact component shape and the human identities. No text added to drawings.”
3. **Apparel:** “Subtle lateral camera move as a shopper and stylist compare garment fabric and fit in a modern store. Small natural fabric and hand movement. Preserve garment colours and people. No talking or in-scene text.”

## Motion-design shots built from vector layers

Do not render labels through a video model. Animate the deterministic vector layers from `render.mjs` or rebuild them in a motion editor using the supplied scene PNGs as composition references.

4. **Silo problem:** Six system panels enter from distinct directions and stop short of one another. A customer intent line tries to travel across and breaks at each gap. ERP, CRM, PIM, Commerce, Search and Service labels stay crisp and editable. End with the customer's repeated question, not a glowing AI brain.
5. **Connection:** Use the architecture clip as the composition reference: ERP, CRM, PIM, commerce, search and knowledge on the left; authentic JourneyAX mark labelled JAX in the centre; guided answers, real options, carts/quotes, human handoff and insights on the right. Animate small yellow signals continuously along the curved paths in both stages. The blurred depth plate sits behind a dark glass panel, while every label stays crisp. Give product/knowledge sources a different motion rhythm from live stock, price, customer and order calls. Never depict all operational data being copied into the Business Pack.
6. **Agent building:** Reveal the Discovery, Product and Quote agents one at a time; their permitted knowledge and tools illuminate beneath them. One yellow selector moves to the agent relevant to the current customer need. No generic humanoid robots.
7. **Business Pack:** Six merchant-controlled tiles assemble into a single playbook ribbon. The final ribbon is stamped “Business Pack” only after brand, knowledge, agents, journeys, rules, cards and themes are visible. Live source systems remain connected outside it.
8. **Adaptive journey:** Animate a customer goal through Goal → Understand → Decide. At Decide, branch visibly: enough context flows straight to a useful action; missing context briefly goes to one relevant question and returns. Then show Recommend → Complete. Do not make all customers pass through identical question cards.
9. **Agent in action:** A customer goal enters the Journey, the Journey selects an approved Agent, and that Agent calls only relevant capabilities. Show four labelled capabilities as selectable, not a compulsory four-step pipeline. The resulting answer includes “why” and an appropriate visual, quote, basket or handoff.
10. **Studio:** Move focus through Connections, Agents, Journeys, Business Packs and Insights. Draw a conceptual path chart with no numbers; it represents what the merchant can inspect, not measured performance. End by showing the merchant owns the experience.
11. **Logo finish:** Let the journey line curve into the authentic JourneyAX mark. No AI-generated lettering. Finish on `journeyax.com` with a clean 2-second hold.

## Edit and sound

- Alternate human shots with system motion. Do not hold one static board for more than 3 seconds without something meaningful changing.
- Prefer hard cuts on message changes, motivated wipes along data paths, and restrained dissolves between the three human contexts. Avoid constant zoom-and-fade transitions.
- Design for sound-off comprehension first. Keep the silent master. An optional instrumental/sound-design version can use licensed audio only; do not add voice.
- Check at 100% scale on a phone and laptop. If a label becomes too small, shorten the wording rather than shrinking type.
- Before public launch, get product-owner approval of every connector and agent-building claim, and replace illustrative product UI with approved product capture wherever the film implies live behaviour.

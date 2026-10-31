/**
 * Side panel: layout mode, width clamping, keyboard steps and dragging.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/panel.test.ts
 */
import assert from 'node:assert/strict';
import {
  PANEL_DEFAULT_WIDTH, PANEL_MIN_MAIN_WIDTH, PANEL_MIN_WIDTH, PANEL_STEP, PANEL_STEP_LARGE, SHEET_BREAKPOINT,
  clampPanelWidth, maxPanelWidth, panelMode, parseStoredWidth, stepPanelWidth, widthFromDrag,
} from '../panel';
import { panelCardCopy, isPanelCardType } from '../panelCards';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const SIDEBAR = 272;

console.log('side panel');

check('the layout follows the window: sheet on a phone, docked with room, overlay when the thread would be squeezed', () => {
  assert.equal(panelMode(390, SIDEBAR), 'sheet');
  assert.equal(panelMode(SHEET_BREAKPOINT, SIDEBAR), 'sheet', 'the breakpoint itself is still a sheet');
  assert.equal(panelMode(SHEET_BREAKPOINT + 1, SIDEBAR), 'overlay', 'just over the breakpoint, with the sidebar open, there is not room for both');
  assert.equal(panelMode(SHEET_BREAKPOINT + 1, 0), 'docked', 'with the sidebar closed there is');
  assert.equal(panelMode(1440, SIDEBAR), 'docked');
  assert.equal(panelMode(PANEL_MIN_MAIN_WIDTH + PANEL_MIN_WIDTH + SIDEBAR, SIDEBAR), 'docked', 'exactly enough room docks');
  assert.equal(panelMode(PANEL_MIN_MAIN_WIDTH + PANEL_MIN_WIDTH + SIDEBAR - 1, SIDEBAR), 'overlay');
  assert.equal(panelMode(1100, 0), 'docked', 'collapsing the sidebar makes room to dock');
  assert.equal(panelMode(NaN, SIDEBAR), 'sheet', 'an unknown width is treated as the safest layout');
});

check('width is clamped to the minimum, to the room left for the thread, and to the absolute maximum', () => {
  assert.equal(clampPanelWidth(100, 1440, SIDEBAR), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(500, 1440, SIDEBAR), 500);
  assert.equal(clampPanelWidth(5000, 1440, SIDEBAR), maxPanelWidth(1440, SIDEBAR));
  assert.equal(maxPanelWidth(1440, SIDEBAR), 1440 - SIDEBAR - PANEL_MIN_MAIN_WIDTH);
  assert.equal(maxPanelWidth(2800, SIDEBAR), 960, 'never wider than the absolute maximum');
  assert.equal(clampPanelWidth(Number.NaN, 1440, SIDEBAR), PANEL_DEFAULT_WIDTH);
  assert.equal(clampPanelWidth(5000, 900, SIDEBAR), 900 - SIDEBAR - 96, 'overlay leaves a strip of the thread visible');
  assert.equal(clampPanelWidth(500, 390, SIDEBAR), 390, 'a sheet fills the screen');
  assert.ok(maxPanelWidth(1440, SIDEBAR) >= PANEL_MIN_WIDTH);
});

check('a stored width is read back only when it is a positive number', () => {
  assert.equal(parseStoredWidth('512'), 512);
  assert.equal(parseStoredWidth(null), null);
  assert.equal(parseStoredWidth(''), null);
  assert.equal(parseStoredWidth('wide'), null);
  assert.equal(parseStoredWidth('-40'), null);
  assert.equal(parseStoredWidth('0'), null);
});

check('arrow keys move the handle (left widens, right narrows), shift takes bigger steps, Home and End jump', () => {
  assert.equal(stepPanelWidth(480, 'ArrowLeft', false, 1440, SIDEBAR), 480 + PANEL_STEP);
  assert.equal(stepPanelWidth(480, 'ArrowRight', false, 1440, SIDEBAR), 480 - PANEL_STEP);
  assert.equal(stepPanelWidth(480, 'ArrowLeft', true, 1440, SIDEBAR), 480 + PANEL_STEP_LARGE);
  assert.equal(stepPanelWidth(PANEL_MIN_WIDTH, 'ArrowRight', false, 1440, SIDEBAR), PANEL_MIN_WIDTH, 'cannot go below the minimum');
  assert.equal(stepPanelWidth(480, 'Home', false, 1440, SIDEBAR), PANEL_MIN_WIDTH);
  assert.equal(stepPanelWidth(480, 'End', false, 1440, SIDEBAR), maxPanelWidth(1440, SIDEBAR));
  assert.equal(stepPanelWidth(maxPanelWidth(1440, SIDEBAR), 'ArrowLeft', false, 1440, SIDEBAR), maxPanelWidth(1440, SIDEBAR), 'cannot go past the maximum');
  assert.equal(stepPanelWidth(480, 'Enter', false, 1440, SIDEBAR), null, 'other keys are ignored');
});

check('dragging the left edge follows the pointer and stays clamped', () => {
  assert.equal(widthFromDrag(1000, 480, 900, 1440, SIDEBAR), 580, 'pointer 100px left makes the panel 100px wider');
  assert.equal(widthFromDrag(1000, 480, 1100, 1440, SIDEBAR), 380);
  assert.equal(widthFromDrag(1000, 480, 1400, 1440, SIDEBAR), PANEL_MIN_WIDTH);
  assert.equal(widthFromDrag(1000, 480, -500, 1440, SIDEBAR), maxPanelWidth(1440, SIDEBAR));
});

check('the thread keeps a one-line note where a panel card was, named from the card itself', () => {
  assert.equal(isPanelCardType('productDetail'), true);
  assert.equal(isPanelCardType('comparison'), true);
  assert.equal(isPanelCardType('products'), false);
  const detail = panelCardCopy({ id: 'a', cardType: 'productDetail', state: { product: { title: 'Wet Area Board 2400' } } });
  assert.equal(detail.note, 'Opened details for Wet Area Board 2400 in the side panel');
  assert.equal(detail.title, 'Wet Area Board 2400');
  assert.equal(panelCardCopy({ id: 'b', cardType: 'productDetail', state: {} }).note, 'Opened product details in the side panel');
  const compare = panelCardCopy({ id: 'c', cardType: 'comparison', state: { products: [{ sku: 'A', title: 'Board A' }, { sku: 'B', title: '' }] } });
  assert.equal(compare.note, 'Opened a comparison of Board A vs B in the side panel');
  assert.equal(compare.title, 'Comparison');
  assert.equal(panelCardCopy({ id: 'd', cardType: 'comparison' }).note, 'Opened a comparison in the side panel');
});

console.log(`✅ web: side panel: ${passed} passed, 0 failed`);

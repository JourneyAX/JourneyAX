import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DeskBoard, { deskGroups } from '../src/components/canvas/desks/DeskBoard';
import ConfirmationCard from '../src/components/cards/ConfirmationCard';

test('the existing care-board presentation keeps unmatched records and labels paged counts rather than inventing totals', () => {
  const view: any = { desk: { deskId: 'service', title: 'My tickets' }, status: 'partial', page: { more: true }, board: { title: 'Care board', groupBy: 'status', titleField: 'subject', groups: [{ value: 'open', label: 'Open' }] }, records: [{ canonicalId: '1', values: { status: 'open', subject: 'Review contact request' } }, { canonicalId: '2', values: { status: 'vendor_new_status', subject: 'Source status changed' } }] };
  assert.equal(deskGroups(view).flatMap(group => group.records).length, 2);
  const html = renderToStaticMarkup(<DeskBoard view={view} onOpen={() => {}} />);
  for (const text of ['Care board', 'Counts cover this page only', 'Review contact request', 'Other returned statuses', '1+']) assert.ok(html.includes(text), text);
});

test('human approval displays exact nested values and an unshortened reply, safely escaped', () => {
  const reply = '<script>source text</script> ' + 'A full reply to review. '.repeat(30);
  const state = { pending: true, confirmationId: 'cf_1', summary: 'Proposed changes', reviewPayload: JSON.stringify({ arguments: { phone: '+64210000000', streetName: 'Reviewed street', reply } }) };
  const html = renderToStaticMarkup(<ConfirmationCard state={state} onAction={() => {}} />);
  assert.ok(html.includes('+64210000000') && html.includes('Reviewed street'));
  assert.equal((html.match(/A full reply to review\./g) || []).length, 30);
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert.ok(!html.includes('disabled=""'));
  const incomplete = renderToStaticMarkup(<ConfirmationCard state={{ ...state, reviewPayload: undefined }} onAction={() => {}} />);
  assert.ok(incomplete.includes('disabled=""'));
  const demo = renderToStaticMarkup(<ConfirmationCard state={{ ...state, reviewSource: { name: 'Merchant CRM', environment: 'test', sample: true } }} onAction={() => {}} />);
  assert.ok(demo.includes('Demonstration connection'));
});

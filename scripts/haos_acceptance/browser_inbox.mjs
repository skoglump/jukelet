/** Populated read-only Ingress inbox proof; importing performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ManagerReadGate, assessManagerRows, assessManagerConnection, completeManagerReadObservation, finalizeManagerReadObservation } from './browser_manager_readonly.mjs';
import { ALBUM_TAG, PLAYLIST_TAG } from './browser_manager.mjs';
import { FIXTURE, REPOSITORY, hash, readPublicInputs } from './browser_inputs.mjs';
import { withinDeadline } from './browser_progress.mjs';

export const INBOX_TAG = 'Jukelet62:observed-only';
export const INBOX_READER = 'Jukelet62 synthetic reader';
const INVENTORY_KEYS = ['tag_key', 'ha_tag_id', 'name', 'last_scanned', 'last_reader', 'observed_at', 'observed_reader', 'state', 'saved_assignment'];
const INBOX_KEYS = [...INVENTORY_KEYS.filter(key => key !== 'saved_assignment'), 'local_assignment'];
const plain = value => assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
const time = value => { assert.equal(typeof value, 'string'); assert.ok(Number.isFinite(Date.parse(value))); };
const keys = (value, names) => { plain(value); assert.deepEqual(Object.keys(value).sort(), [...names].sort()); };
function envelope(value, membership = false) {
  keys(value, ['tags', 'total', 'registry_available', 'stale', 'updated_at', 'discovery_gap', ...(membership ? ['assignments_available'] : [])]);
  assert.equal(value.registry_available, true); assert.equal(value.stale, false); assert.equal(value.discovery_gap, false); time(value.updated_at);
  if (membership) assert.equal(value.assignments_available, true);
  assert.ok(Array.isArray(value.tags)); assert.equal(value.total, value.tags.length); assert.ok(value.total <= 100);
  assert.equal(new Set(value.tags.map(row => row.tag_key)).size, value.total);
  assert.equal(new Set(value.tags.map(row => row.ha_tag_id)).size, value.total);
}
function inventoryRow(row) {
  keys(row, INVENTORY_KEYS); assert.equal(row.tag_key, hash(row.ha_tag_id));
  assert.ok(row.name === null || typeof row.name === 'string' && row.name.length <= 1024);
  assert.ok(['registered', 'pending_discovery'].includes(row.state));
  for (const value of [row.last_scanned, row.observed_at]) if (value !== null) time(value);
  for (const value of [row.last_reader, row.observed_reader]) assert.ok(value === null || typeof value === 'string' && value.length <= 1024);
}

export function assessInboxState({ inventory, assignments }, now = Date.now()) {
  envelope(inventory); assert.equal(inventory.total, 3); inventory.tags.forEach(inventoryRow);
  assert.deepEqual(inventory.tags.map(row => row.ha_tag_id).sort(), [ALBUM_TAG, PLAYLIST_TAG, INBOX_TAG].sort());
  const saved = inventory.tags.filter(row => row.ha_tag_id !== INBOX_TAG);
  // The original two-tag/null-scan contract remains strict and unmodified.
  const proof = assessManagerRows({ assignments, inventory: { ...inventory, tags: saved, total: 2 } });
  for (const row of saved) { assert.equal(row.observed_at, null); assert.equal(row.observed_reader, null); }
  const tag = inventory.tags.find(row => row.ha_tag_id === INBOX_TAG);
  assert.equal(tag.saved_assignment, null); assert.equal(tag.observed_reader, INBOX_READER); time(tag.observed_at);
  assert.ok(Number.isFinite(now)); const age = now - Date.parse(tag.observed_at); assert.ok(age >= -5000 && age <= 300000);
  assert.equal(assignments.assignments.some(row => row.tag_key === tag.tag_key || row.ha_tag_id === INBOX_TAG), false);
  return { saved: proof, saved_projection: 'TWO_SAVED_TAGS_FROM_COMPLETE_THREE_TAG_INVENTORY', inventory_total: 3, inbox_tag_key: tag.tag_key, state: tag.state,
    name_sha256: tag.name === null ? null : hash(tag.name), observed_at: tag.observed_at,
    observed_reader_matches: true, observation_age_ms: age, inventory_last_scanned: tag.last_scanned,
    inventory_last_reader_matches: tag.last_reader === INBOX_READER, core_registry_scan_time: 'NOT_QUERIED_BY_ACTOR', no_local_assignment: true };
}

// Complete membership is independent of the requested filtered response. A
// disabled saved draft remains assigned; registry labels never imply membership.
export function assessInboxMembership(value, view, { inventory, assignments }) {
  assert.ok(['unassigned', 'observed'].includes(view)); envelope(value, true); envelope(inventory);
  plain(assignments); assert.equal(assignments.total, assignments.assignments.length);
  const members = new Map();
  for (const row of assignments.assignments) {
    assert.equal(row.tag_key, hash(row.ha_tag_id)); assert.equal(typeof row.enabled, 'boolean');
    assert.equal(members.has(row.tag_key), false); members.set(row.tag_key, row.enabled ? 'enabled' : 'disabled');
  }
  const expected = inventory.tags.map(row => {
    inventoryRow(row); const { saved_assignment, ...tag } = row;
    assert.equal(saved_assignment === null, !members.has(row.tag_key));
    if (saved_assignment !== null) assert.deepEqual(saved_assignment, assignments.assignments.find(saved => saved.tag_key === row.tag_key));
    return { ...tag, local_assignment: members.get(row.tag_key) ?? 'unassigned' };
  }).filter(row => view === 'observed' ? row.observed_at !== null : row.local_assignment === 'unassigned');
  if (view === 'observed') expected.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  for (const row of value.tags) keys(row, INBOX_KEYS);
  assert.deepEqual(value.tags, expected); assert.equal(value.total, expected.length);
  return { view, total: value.total, complete_membership: true, complete_saved_rows: assignments.total,
    disabled_saved_rows: assignments.assignments.filter(row => row.enabled === false).length,
    disabled_saved_exclusion_demonstrated: view === 'unassigned' && assignments.assignments.some(row => row.enabled === false),
    assigned_tags_excluded: view === 'unassigned', exact_rows: true };
}

export function assessPopulatedInbox(value, view, state, now = Date.now()) {
  const proof = assessInboxState(state, now), membership = assessInboxMembership(value, view, state);
  assert.equal(value.total, 1); assert.equal(value.tags[0].ha_tag_id, INBOX_TAG);
  return { ...membership, ...proof, populated_observation_demonstrated: true };
}

async function dom(gate, operation) {
  gate.check(); const result = await withinDeadline('dom', operation, { timeoutMs: 5000 }); gate.check(); return result;
}
async function localTimes(manager, gate, values) {
  return dom(gate, () => manager.frame.evaluate(times => times.map(value => value === null ? 'Unavailable' : new Date(value).toLocaleString()), values));
}
const stateLabel = row => row.state === 'registered' ? 'Registered tag' : 'Pending registry discovery';
const memberLabel = row => ({ unassigned: 'No local assignment', enabled: 'Enabled local draft', disabled: 'Disabled local draft (still assigned)' })[row.local_assignment];

export async function assertInboxList(manager, gate, region, body) {
  const times = await localTimes(manager, gate, body.tags.map(row => row.observed_at));
  const expected = body.tags.map((row, i) => ({ name: row.name ?? 'Unnamed tag', id: row.ha_tag_id,
    paragraphs: [stateLabel(row), memberLabel(row), `Observed by this app: ${times[i]} · Reader: ${row.observed_reader ?? 'Not provided'}`],
    codes: [row.ha_tag_id, row.observed_reader ?? 'Not provided'] }));
  await dom(gate, () => manager.expect.poll(async () => dom(gate, () => region.locator(':scope > ul.tag-list > li').evaluateAll(elements =>
    elements.map(element => ({ name: element.querySelector(':scope > strong')?.textContent ?? null,
      id: element.querySelector(':scope > code.exact-id')?.textContent ?? null,
      paragraphs: [...element.querySelectorAll(':scope > p')].map(item => item.textContent),
      codes: [...element.querySelectorAll('code.exact-id')].map(item => item.textContent) })))), { timeout: 5000 }).toEqual(expected));
  const [updated] = await localTimes(manager, gate, [body.updated_at]);
  await dom(gate, () => manager.expect(region).toContainText(`Registry updated: ${updated}.`, { timeout: 5000 }));
  for (const warning of ['Showing previous', 'Loading discovery', 'Registry snapshot is stale', 'Local assignment membership is unknown',
    'Scans may have been missed', 'Registry unavailable', 'retained discovery snapshot']) {
    await dom(gate, () => manager.expect(region).not.toContainText(warning, { timeout: 5000 }));
  }
  await dom(gate, () => manager.expect(region.getByRole('alert')).toHaveCount(0, { timeout: 5000 }));
}

export async function assertInboxDetail(manager, gate, region, row) {
  await dom(gate, () => manager.expect(region).toHaveCount(1, { timeout: 5000 }));
  await dom(gate, () => manager.expect.poll(async () => dom(gate, () => region.evaluateAll(elements => elements.map(element => ({
    name: element.querySelector(':scope > h4')?.textContent ?? null,
    id: element.querySelector(':scope > code.exact-id')?.textContent ?? null,
    paragraphs: [...element.querySelectorAll(':scope > p')].map(item => item.textContent),
  })))), { timeout: 5000 }).toEqual([{ name: row.name ?? 'Unnamed tag', id: row.ha_tag_id,
    paragraphs: [stateLabel(row), memberLabel(row), 'Assignment editing is separate in tag detail. This onboarding flow does not save assignments or publish playback.'] }]));
}

export async function exercisePopulatedInbox(manager, gate, evidence, setStage = () => {}, coreVersion, now = Date.now()) {
  const region = name => manager.frame.getByRole('region', { name, exact: true });
  const read = async (endpoint, mark) => { const result = await gate.read(endpoint, mark); gate.check(); return result; };
  const stage = value => { gate.check(); setStage(value); };
  const saved = region('Saved local drafts'), inventoryRegion = region('Tag inventory'), inbox = region('Tag onboarding');
  const refreshSaved = saved.getByRole('button', { name: 'Refresh saved drafts', exact: true });
  async function snapshot(label) {
    stage(label); await dom(gate, () => manager.expect(refreshSaved).toBeEnabled({ timeout: 5000 }));
    const mark = gate.mark(); await dom(gate, () => refreshSaved.click({ timeout: 5000 }));
    const assignments = await read('assignments?offset=0&limit=100', mark), recovery = await read('recovery', mark);
    assert.deepEqual(recovery.body, { reconciliation_required: false });
    const pollMark = gate.mark(), inventory = await read('tags?offset=0&limit=100', pollMark), status = await read('status', pollMark);
    const state = { assignments: assignments.body, inventory: inventory.body };
    const proof = assessInboxState(state, now); assessManagerConnection(status.body, coreVersion);
    evidence[label] = { ...proof, assignments_receipt: assignments.receipt, inventory_receipt: inventory.receipt, status_receipt: status.receipt,
      recovery_receipt: recovery.receipt, actual_core_version: status.body.version };
    return state;
  }
  const state = await snapshot('inbox_before'); evidence.views = {};
  async function view(label, selected, action) {
    stage('inbox_' + label);
    if (action === 'refresh') await dom(gate, () => manager.expect(inbox.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeEnabled({ timeout: 5000 }));
    const mark = gate.mark();
    if (action === 'open') await dom(gate, () => inventoryRegion.getByRole('button', { name: 'Add tag / unassigned inbox', exact: true }).click({ timeout: 5000 }));
    else if (action === 'select') await dom(gate, () => inbox.getByLabel('Discovery view', { exact: true }).selectOption(selected, { timeout: 5000 }));
    else await dom(gate, () => inbox.getByRole('button', { name: 'Refresh discovery', exact: true }).click({ timeout: 5000 }));
    const found = await read(`tags/inbox?view=${selected}&offset=0&limit=100`, mark);
    evidence.views[label] = { ...assessPopulatedInbox(found.body, selected, state, now), receipt: found.receipt };
    await dom(gate, () => manager.expect(inbox.getByLabel('Discovery view', { exact: true })).toHaveValue(selected, { timeout: 5000 }));
    await assertInboxList(manager, gate, inbox, found.body); evidence.views[label].current_rows_rendered = true;
    return found.body;
  }
  await view('opened_unassigned', 'unassigned', 'open');
  await view('refreshed_unassigned', 'unassigned', 'refresh');
  await view('selected_observed', 'observed', 'select');
  await view('refreshed_observed', 'observed', 'refresh');
  const chosen = await view('selected_unassigned', 'unassigned', 'select');
  const row = chosen.tags[0], detail = region('Discovered tag'); stage('inbox_choose');
  await dom(gate, () => inbox.getByRole('button', { name: `Choose discovered tag ${row.name ?? 'Unnamed tag'}`, exact: true }).click({ timeout: 5000 }));
  await view('detail_refreshed', 'unassigned', 'refresh'); await assertInboxDetail(manager, gate, detail, row);
  stage('inbox_back'); await dom(gate, () => detail.getByRole('button', { name: 'Back to discoveries', exact: true }).click({ timeout: 5000 }));
  await dom(gate, () => manager.expect(detail).toHaveCount(0, { timeout: 5000 }));
  await view('back_refreshed', 'unassigned', 'refresh');
  stage('inbox_close'); await dom(gate, () => inbox.getByRole('button', { name: 'Close onboarding', exact: true }).click({ timeout: 5000 }));
  await dom(gate, () => manager.expect(inbox).toHaveCount(0, { timeout: 5000 }));
  evidence.local_navigation = { choose: true, detail_current: true, back: true, close: true, detail_reader_time_fields: 'NOT_PRESENT_IN_DETAIL_UI_LIST_VERIFIED' };
  const after = await snapshot('inbox_after');
  assert.deepEqual(after.assignments, state.assignments);
  assert.deepEqual(after.inventory.tags, state.inventory.tags);
  assert.equal(gate.evidence().unexpected_mutations, 0); assert.equal(gate.evidence().metadata_previews, 1);
}

export async function runInbox(path) {
  const report = { fixture: FIXTURE, phase: 'external-inbox', result: 'FAIL', checks: {}, limitations: [
    'Read-only populated inbox after one separate Root-owned fixed synthetic scan; original issue62 remains PARTIAL.',
    'Actor never scans, renames, saves, restores, publishes or grants download permission; existing bootstrap preview is the only non-auth POST.',
    'Root independently joins scan submission/effective actual HA registry/app observation/reader/time and bridge ignored-disabled diagnostics.',
    'Root proves whole protected business/history/publisher/guard/roles/image/script0 and normal actor/Chrome/WM/Xvfb exits before/after.',
    'Forward third-tag/observation/bridge last-scan baseline remains; no reset to historical two-tag/null-scan validators.',
  ] };
  const gate = new ManagerReadGate(), now = Date.now(); let manager, stage = 'local_inputs';
  const attempted = request => gate.started(request);
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_inbox.mjs', 'browser_manager_readonly.mjs', 'browser_external.mjs', 'browser.mjs',
      'browser_inputs.mjs', 'browser_manager.mjs', 'browser_core_profiles.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path);
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    manager = await openNativeManager(inputs, report, { externalBrowser: true, terminalReadGate: gate, requestAllowed: (request, scope) => gate.allow(request, scope),
      setStage: value => { stage = value; } });
    const binding = manager.externalSession.managerReadonlyBinding(); gate.bind(binding); manager.page.on('request', attempted);
    report.checks.populated_inbox = {};
    await exercisePopulatedInbox(manager, gate, report.checks.populated_inbox, value => { stage = value; }, binding.coreVersion, now);
    gate.check(); await manager.externalSession.checkWorkers(true); gate.check();
    stage = 'inbox_cleanup'; await completeManagerReadObservation(manager, gate);
    report.checks.external.guard = manager.externalSession.evidence(); assert.equal(report.checks.external.guard.failure, null);
    const { expected_fixture_warning, ...network } = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.checks.network_assessment = network; report.checks.expected_fixture_warning = expected_fixture_warning;
    assert.equal(gate.evidence().failure, null); report.result = 'PASS'; stage = 'complete';
  } catch { report.code = 'native_inbox_failed'; }
  finally {
    report.checks.read_observer_finalization = await finalizeManagerReadObservation(manager, gate, attempted);
    if (manager) report.checks.network = { ...manager.network };
    report.checks.inbox_gate = gate.evidence(); report.stage = stage;
    if (report.checks.inbox_gate.failure || report.checks.cleanup?.cleanup_confirmed === false) { report.result = 'FAIL'; report.code ??= 'native_inbox_failed'; }
  }
  return report;
}

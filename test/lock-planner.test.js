import test from 'node:test';
import assert from 'node:assert/strict';

import { LockPlanner, planEscalation } from '../src/lock-planner.js';

function rowLocks(txnId, table, count) {
  return Array.from({ length: count }, (_, i) => ({
    txnId,
    table,
    rowId: `r${i}`,
  }));
}

test('multi-transaction escalation: independent tables all escalate safely', () => {
  const result = planEscalation({
    transactions: [
      { id: 'T1', workDone: 10 },
      { id: 'T2', workDone: 20 },
      { id: 'T3', workDone: 30 },
    ],
    rowLocks: [
      ...rowLocks('T1', 'orders', 150),
      ...rowLocks('T2', 'items', 120),
      ...rowLocks('T3', 'users', 5),
    ],
    escalationThreshold: 100,
    memoryBudget: 1000,
  });

  assert.deepEqual(
    result.escalations.map((e) => [e.txnId, e.table]),
    [
      ['T1', 'orders'],
      ['T2', 'items'],
    ],
  );
  assert.deepEqual(result.victims, []);
  assert.deepEqual(result.remainingWaitCycles, []);
  // 150 + 120 row locks fold into 2 table locks; T3 keeps its 5 row locks.
  assert.equal(result.memoryBefore, 275);
  assert.equal(result.memoryAfter, 2 + 5);
  assert.equal(
    result.escalations.find((e) => e.txnId === 'T1').rowLocksReleased,
    150,
  );
});

test('escalation contention on one table: cheapest transaction becomes victim', () => {
  const result = planEscalation({
    transactions: [
      { id: 'T1', workDone: 500 },
      { id: 'T2', workDone: 100 },
    ],
    rowLocks: [...rowLocks('T1', 'orders', 200), ...rowLocks('T2', 'orders', 180)],
    escalationThreshold: 100,
  });

  // Both want the same table: each blocks the other, forming a cycle.
  // T2 has done less work, so T2 is rolled back and T1 escalates.
  assert.deepEqual(result.victims, ['T2']);
  assert.deepEqual(
    result.escalations.map((e) => e.txnId),
    ['T1'],
  );
  assert.deepEqual(result.remainingWaitCycles, []);
});

test('late-arriving wait edge changes the wait graph and creates a victim', () => {
  const planner = new LockPlanner({
    transactions: [
      { id: 'T1', workDone: 10 },
      { id: 'T2', workDone: 90 },
    ],
    rowLocks: [...rowLocks('T1', 'a', 3), ...rowLocks('T2', 'b', 3)],
    waitEdges: [{ from: 'T1', to: 'T2' }],
  });

  const before = planner.plan();
  assert.deepEqual(before.victims, []);
  assert.deepEqual(before.remainingWaitCycles, []);

  // The reverse edge arrives late, closing a cycle T1 -> T2 -> T1.
  planner.addWaitEdges([{ from: 'T2', to: 'T1' }]);
  const after = planner.plan();
  assert.deepEqual(after.victims, ['T1']); // least workDone
  assert.deepEqual(after.remainingWaitCycles, []);
});

test('duplicate escalation requests collapse into a single escalation', () => {
  const planner = new LockPlanner({
    transactions: [{ id: 'T1', workDone: 5 }],
    rowLocks: rowLocks('T1', 'orders', 250),
    escalationThreshold: 100,
  });
  planner.requestEscalation('T1', 'orders');
  planner.requestEscalation('T1', 'orders');
  planner.requestEscalation('T1', 'orders');

  const result = planner.plan();
  assert.equal(result.escalations.length, 1);
  assert.deepEqual(result.escalations[0].reasons, ['requested', 'threshold']);
  assert.equal(result.escalations[0].rowLocksReleased, 250);
});

test('committed transactions never escalate and release their locks', () => {
  const planner = new LockPlanner({
    transactions: [
      { id: 'T1', state: 'committed', workDone: 1000 },
      { id: 'T2', workDone: 10 },
    ],
    rowLocks: [...rowLocks('T1', 'orders', 300), ...rowLocks('T2', 'orders', 150)],
    waitEdges: [{ from: 'T2', to: 'T1' }],
    escalationThreshold: 100,
  });
  planner.requestEscalation('T1', 'orders'); // ignored: already committed

  const result = planner.plan();
  // T1's locks are gone, so T2 escalates without waiting and without victims.
  assert.deepEqual(
    result.escalations.map((e) => e.txnId),
    ['T2'],
  );
  assert.deepEqual(result.victims, []);
  assert.deepEqual(result.waitEdges, []);
  assert.equal(result.memoryBefore, 150);
});

test('partial commit between plans unblocks a deferred escalation', () => {
  const planner = new LockPlanner({
    transactions: [
      { id: 'T1', workDone: 800 },
      { id: 'T2', workDone: 50 },
    ],
    rowLocks: [...rowLocks('T1', 'orders', 400), ...rowLocks('T2', 'orders', 150)],
    escalationThreshold: 100,
  });

  const blocked = planner.plan();
  // T1 and T2 contend on the same table; T2 (less work) is the victim.
  assert.deepEqual(blocked.victims, ['T2']);

  // Fresh scenario, but T1 commits before the plan is computed.
  const planner2 = new LockPlanner({
    transactions: [
      { id: 'T1', workDone: 800 },
      { id: 'T2', workDone: 50 },
    ],
    rowLocks: [...rowLocks('T1', 'orders', 400), ...rowLocks('T2', 'orders', 150)],
    escalationThreshold: 100,
  });
  planner2.commitTransaction('T1');
  const unblocked = planner2.plan();
  assert.deepEqual(unblocked.victims, []);
  assert.deepEqual(
    unblocked.escalations.map((e) => e.txnId),
    ['T2'],
  );
  assert.deepEqual(unblocked.remainingWaitCycles, []);
});

test('wait graph cycle is reported when no victim may be chosen', () => {
  const result = planEscalation({
    transactions: [
      { id: 'T1', workDone: 1 },
      { id: 'T2', workDone: 2 },
      { id: 'T3', workDone: 3 },
    ],
    waitEdges: [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T3' },
      { from: 'T3', to: 'T1' },
    ],
    maxVictims: 0,
  });

  assert.deepEqual(result.victims, []);
  assert.deepEqual(result.remainingWaitCycles, [['T1', 'T2', 'T3']]);
});

test('memory budget forces escalation of the largest lock holder', () => {
  const result = planEscalation({
    transactions: [
      { id: 'T1', workDone: 10 },
      { id: 'T2', workDone: 20 },
    ],
    rowLocks: [...rowLocks('T1', 'big', 90), ...rowLocks('T2', 'small', 30)],
    escalationThreshold: 1000, // threshold alone would trigger nothing
    memoryBudget: 50,
  });

  assert.deepEqual(
    result.escalations.map((e) => [e.txnId, e.table, e.reasons]),
    [['T1', 'big', ['budget']]],
  );
  // 90 row locks fold into 1 table lock; T2 keeps its 30 row locks.
  assert.equal(result.memoryAfter, 31);
});

test('victim selection respects rollback order by executed work', () => {
  const result = planEscalation({
    transactions: [
      { id: 'T1', workDone: 300 },
      { id: 'T2', workDone: 100 },
      { id: 'T3', workDone: 200 },
    ],
    waitEdges: [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T1' }, // cycle A: T1 <-> T2
      { from: 'T1', to: 'T3' },
      { from: 'T3', to: 'T1' }, // cycle B: T1 <-> T3
    ],
  });

  // T2 is cheapest; removing T2 still leaves T1 <-> T3, so T3 goes next.
  // After T2 and T3 are gone, no cycle remains and T1 survives.
  assert.deepEqual(result.victims, ['T2', 'T3']);
  assert.deepEqual(result.remainingWaitCycles, []);
});

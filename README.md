# database-lock-escalation-recovery-planner

规划锁升级、等待图和事务回滚恢复。

> **注意：本项目中所有锁状态均为模拟（simulated）。** 不连接任何真实
> 数据库、锁管理器或事务系统；规划器仅对输入的锁/等待数据进行推理并
> 输出计划，不会获取或释放任何真实锁。

## 环境

- Node.js >= 24.16.0（开发验证版本为 24.16.0）

## 问题背景

事务持有大量行锁后会触发锁升级（行锁 → 表锁）。锁管理器释放部分行锁
后等待图发生变化，如果另一个事务正在等待其中一行，错误的升级顺序可能
形成新的死锁。本规划器根据事务、行锁、表锁、等待边、锁内存预算和已执
行工作量，计算安全的升级集合与回滚顺序。

## 输入

```js
import { LockPlanner, planEscalation } from './src/lock-planner.js';

const planner = new LockPlanner({
  transactions: [
    { id: 'T1', state: 'active', workDone: 100 }, // state: active | committed | aborted
    { id: 'T2', workDone: 500 },                  // state 缺省为 active
  ],
  rowLocks: [{ txnId: 'T1', table: 'orders', rowId: 'r1' }],
  tableLocks: [{ txnId: 'T2', table: 'items' }],
  waitEdges: [{ from: 'T1', to: 'T2' }], // T1 等待 T2
  memoryBudget: 1000,        // 行锁内存预算（槽位数）
  escalationThreshold: 500,  // 单事务单表行锁数达到该值即触发升级
  maxVictims: Infinity,      // 允许回滚的最大事务数
});
```

## 输出

`plan()` 返回：

- `escalations`：安全升级集合（事务、表、释放的行锁数、触发原因）
- `deferred`：因他事务持锁而推迟的升级及其等待对象
- `victims`：牺牲事务，按回滚顺序排列（优先回滚已执行工作量最小者）
- `remainingWaitCycles`：回滚后仍剩余的等待环（正常为空；受
  `maxVictims` 限制时可能非空）
- `waitEdges`：最终等待图（含升级引入的新等待边）
- `memoryBefore` / `memoryAfter`：升级前后的模拟锁内存占用

## 边界情况

- **升级竞争**：多个事务竞争同一表的升级时互相阻塞成环，按工作量选择
  牺牲事务，幸存者完成升级。
- **等待边晚到**：`addWaitEdges()` 可在任意时刻注册新边，再次调用
  `plan()` 会基于最新等待图重新计算。
- **重复升级**：`requestEscalation()` 与阈值/预算触发的候选自动去重，
  同一（事务， 表）只升级一次。
- **事务已提交**：已提交/已中止事务的锁视为已释放，其升级请求被忽略，
  相关等待边从图中移除（部分提交场景用 `commitTransaction()` 模拟）。

## 测试

```sh
node --test
```

测试覆盖：多事务升级、升级竞争、等待图变化（等待边晚到）、重复升级、
事务已提交与部分提交、内存预算驱动的升级、回滚顺序与剩余等待环。

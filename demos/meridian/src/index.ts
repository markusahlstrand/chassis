export { meridianModule, meridianManifest, HR_PERM } from './module.js';
export type {
  EmployeeRow,
  LeaveTypeRow,
  LedgerRow,
  LeaveRequestRow,
  ProjectRow,
  TimeEntryRow,
  ExpenseRow,
} from './module.js';
export {
  buildDemoHost,
  seedDemo,
  provisionMeridian,
  MODULES,
  ROLES,
  ENTITY_GRANTS,
  type MeridianInstance,
  type DemoWorld,
} from './seed.js';

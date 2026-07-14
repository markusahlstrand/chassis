export { servicecoModule, servicecoManifest, SC_PERM } from './module.js';
// Protocol machinery lives in the engine since milestone B; re-exported here
// for the scenario test's convenience.
export {
  PROTOCOL_PERM as PROTO_PERM,
  protocolContentHash,
  requireSigned,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
  type ProtocolSummary,
  type ProtocolTemplateRow,
} from '@substrat-run/engine-protocol';
export { buildDemoHost, seedDemo, type DemoWorld } from './seed.js';

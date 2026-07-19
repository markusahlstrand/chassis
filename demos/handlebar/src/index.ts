export { bikeShopModule, bikeShopManifest, CS_PERM } from './module.js';
// Protocol machinery is the engine's (milestone B); re-exported here for the
// scenario test's convenience.
export {
  PROTOCOL_PERM,
  protocolContentHash,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
  type ProtocolSummary,
  type ProtocolTemplateRow,
} from '@substrat-run/engine-protocol';
export {
  buildBikeShopHost,
  seedBikeShop,
  provisionHandlebar,
  type HandlebarInstance,
  type BikeShopWorld,
} from './seed.js';

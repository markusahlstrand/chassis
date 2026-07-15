import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { shopModule, SHOP_PERM } from './module.js';

export interface ShopWorld {
  t1: TenantId; // Kallkälla Kaffe AB
  t2: TenantId; // Bönfeber Rosteri AB (the attack victim owner)
  s1: ScopeId; // Kallkälla web shop
  s2: ScopeId; // Bönfeber web shop
  astrid: PrincipalId; // shop-admin (tenant-level)
  gustav: PrincipalId; // warehouse @ s1
  elin: PrincipalId; // customer-shopper (Café Pascal)
  otto: PrincipalId; // customer-shopper (Kontoret Otto)
  guest: PrincipalId; // anonymous shopper — no order grant
  public: PrincipalId; // browse-only fallback for not-logged-in visitors
  rurik: PrincipalId; // shop-admin @ t2 — the attacker
  elinCustomerId: string;
  ottoCustomerId: string;
  microLotVariantId: string; // Gichichi AA 250 g — on_hand 1 (the oversell beat)
  chelbesaVariantId: string; // Chelbesa 250 g — the TTL-release beat
}

export function buildShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  host.registerModule(invoicingModule);
  host.registerModule(shopModule);
  return host;
}

/** Idempotent: safe on every server start; demo data seeds only once. */
export async function seedShop(host: SqliteScopeHost, dir: string): Promise<ShopWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s2: ulid(),
        astrid: ulid(), gustav: ulid(), elin: ulid(), otto: ulid(), guest: ulid(),
        public: ulid(), rurik: ulid(),
        elinCustomerId: '', ottoCustomerId: '', microLotVariantId: '', chelbesaVariantId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: ShopWorld = {
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s2: scopeId.parse(raw.s2),
    astrid: principalId.parse(raw.astrid), gustav: principalId.parse(raw.gustav),
    elin: principalId.parse(raw.elin), otto: principalId.parse(raw.otto),
    guest: principalId.parse(raw.guest),
    // Tolerant of a cast.json written before `public` existed — anonymous browse
    // is stateless, so a fresh id per start is fine.
    public: principalId.parse(raw.public ?? ulid()),
    rurik: principalId.parse(raw.rurik),
    elinCustomerId: raw.elinCustomerId ?? '', ottoCustomerId: raw.ottoCustomerId ?? '',
    microLotVariantId: raw.microLotVariantId ?? '', chelbesaVariantId: raw.chelbesaVariantId ?? '',
  };

  const staff = platformActorId.parse(ulid());

  host.admin.createTenant(staff, { id: world.t1, slug: 'kallkalla', name: 'Kallkälla Kaffe AB' });
  host.admin.createTenant(staff, { id: world.t2, slug: 'bonfeber', name: 'Bönfeber Rosteri AB' });

  // Entitlements (§4.3): default-deny — grant the SKU flags for the modules the
  // shop runs before its operations resolve.
  for (const t of [world.t1, world.t2]) {
    for (const key of ['invoicing', 'shop']) {
      host.admin.grantEntitlement(staff, t, key);
    }
  }

  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope(staff, { tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  const adminPerms = [
    SHOP_PERM.catalogManage, SHOP_PERM.stockManage, SHOP_PERM.discountManage,
    SHOP_PERM.customerManage, SHOP_PERM.orderRead, SHOP_PERM.orderFulfil,
    SHOP_PERM.browse, SHOP_PERM.checkout,
    INV.read, INV.export,
  ];
  const warehousePerms = [SHOP_PERM.stockManage, SHOP_PERM.orderFulfil, SHOP_PERM.orderRead, SHOP_PERM.browse];
  const shopperPerms = [SHOP_PERM.browse, SHOP_PERM.checkout];
  const publicPerms = [SHOP_PERM.browse]; // anonymous visitors: read the catalogue only

  for (const t of [world.t1, world.t2]) {
    host.admin.defineRole(staff, t, { key: 'shop-admin', permissions: adminPerms, source: 'vertical' });
    host.admin.defineRole(staff, t, { key: 'warehouse', permissions: warehousePerms, source: 'vertical' });
    host.admin.defineRole(staff, t, { key: 'shopper', permissions: shopperPerms, source: 'vertical' });
    host.admin.defineRole(staff, t, { key: 'public', permissions: publicPerms, source: 'vertical' });
  }

  host.admin.assignRole(staff, { principalId: world.astrid, roleKey: 'shop-admin', node: { tenantId: world.t1, scopeId: null } });
  host.admin.assignRole(staff, { principalId: world.gustav, roleKey: 'warehouse', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole(staff, { principalId: world.elin, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole(staff, { principalId: world.otto, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole(staff, { principalId: world.guest, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole(staff, { principalId: world.public, roleKey: 'public', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole(staff, { principalId: world.rurik, roleKey: 'shop-admin', node: { tenantId: world.t2, scopeId: null } });

  if (fresh) {
    const stub = await host.getScope(world.astrid, world.t1, world.s1);

    const gichichi = await stub.invoke<{ id: string }>('shop/create-product', {
      slug: 'gichichi-aa', name: 'Gichichi AA', origin: 'Kenya · Nyeri',
      notes: 'Svarta vinbär, blodgrapefrukt, rabarber.', roast: 1,
    });
    const microLot = await stub.invoke<{ id: string }>('shop/add-variant', {
      productId: gichichi.id, sku: 'GICH-250-HB', grind: 'Hela bönor', sizeLabel: '250 g', priceAmount: '189',
    });
    await stub.invoke('shop/set-stock', { variantId: microLot.id, onHand: 1 }); // the micro-lot
    await stub.invoke('shop/publish-product', { productId: gichichi.id });

    const chelbesa = await stub.invoke<{ id: string }>('shop/create-product', {
      slug: 'chelbesa', name: 'Chelbesa', origin: 'Etiopien · Gedeb',
      notes: 'Jasmin, persika, bergamott.', roast: 1,
    });
    const chelbesaVariant = await stub.invoke<{ id: string }>('shop/add-variant', {
      productId: chelbesa.id, sku: 'CHEL-250-HB', grind: 'Hela bönor', sizeLabel: '250 g', priceAmount: '165',
    });
    await stub.invoke('shop/set-stock', { variantId: chelbesaVariant.id, onHand: 20 });
    await stub.invoke('shop/publish-product', { productId: chelbesa.id });

    await stub.invoke('shop/create-discount', { code: 'KALLKALLA10', kind: 'pct', value: '10', uses: 100 });

    const elinCustomer = await stub.invoke<{ id: string }>('shop/create-customer', {
      number: 'K-100', name: 'Café Pascal', orgRef: 'org:cafe-pascal',
    });
    const ottoCustomer = await stub.invoke<{ id: string }>('shop/create-customer', {
      number: 'K-101', name: 'Kontoret Otto AB',
    });

    world.elinCustomerId = elinCustomer.id;
    world.ottoCustomerId = ottoCustomer.id;
    world.microLotVariantId = microLot.id;
    world.chelbesaVariantId = chelbesaVariant.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed order:read per customer.
  if (world.elinCustomerId) {
    host.admin.grant(staff, {
      principalId: world.elin, permission: SHOP_PERM.orderRead,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.elinCustomerId },
      grantedBy: world.astrid,
    });
  }
  if (world.ottoCustomerId) {
    host.admin.grant(staff, {
      principalId: world.otto, permission: SHOP_PERM.orderRead,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.ottoCustomerId },
      grantedBy: world.astrid,
    });
  }

  return world;
}

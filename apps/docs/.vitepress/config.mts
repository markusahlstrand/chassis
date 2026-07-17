import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(defineConfig({
  title: 'Substrat',
  description:
    'The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.',
  lastUpdated: true,

  vite: {
    // mermaid ships ESM that default-imports CJS deps (dayjs); without
    // pre-bundling, the browser throws and the whole app fails to mount.
    optimizeDeps: { include: ['mermaid', 'dayjs'] },
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-substrat', activeMatch: '/guide/' },
      { text: 'Concepts', link: '/concepts/tenancy', activeMatch: '/concepts/' },
      { text: 'Engines', link: '/engines/', activeMatch: '/engines/' },
      { text: 'Reference', link: '/reference/contracts', activeMatch: '/reference/' },
    ],

    sidebar: {
      '/guide/': guideSidebar(),
      '/concepts/': guideSidebar(),
      '/engines/': guideSidebar(),
      '/reference/': guideSidebar(),
    },

    outline: { level: [2, 3] },

    socialLinks: [{ icon: 'github', link: 'https://github.com/substrat-run/substrat' }],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'The hard parts, hosted.',
    },
  },
}));

// The engine doc pattern, in one place: every engine gets the same five pages in
// the same order, so a reader who learns one learns all. If a new engine can't
// fill all five, that's a gap in the engine, not in the template.
// See the "How these pages are organized" section of /engines/.
function engineSidebar(slug: string, text: string) {
  return {
    text,
    collapsed: true,
    items: [
      { text: 'Overview', link: `/engines/${slug}/` },
      { text: 'Domain model & invariants', link: `/engines/${slug}/model` },
      { text: 'Operations & permissions', link: `/engines/${slug}/surface` },
      { text: 'Events', link: `/engines/${slug}/events` },
      { text: 'Composing & extending', link: `/engines/${slug}/composing` },
    ],
  };
}

function guideSidebar() {
  return [
    {
      text: 'Introduction',
      items: [
        { text: 'What is Substrat?', link: '/guide/what-is-substrat' },
        { text: 'Why runtime enforcement?', link: '/guide/why-substrat' },
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Running locally', link: '/guide/running-locally' },
        { text: 'Building for AI agents', link: '/guide/ai-agents' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Tenants & scopes', link: '/concepts/tenancy' },
        { text: 'The platform layer', link: '/concepts/platform' },
        { text: 'Operations & the scope host', link: '/concepts/scope-host' },
        { text: 'Permissions', link: '/concepts/permissions' },
        { text: 'Authentication & identity', link: '/concepts/identity' },
        { text: 'Events & audit', link: '/concepts/events' },
        { text: 'Reads & scaling', link: '/concepts/reads' },
        { text: 'Modules & the manifest', link: '/concepts/modules' },
        { text: 'Money', link: '/concepts/money' },
      ],
    },
    {
      text: 'Engines',
      items: [
        { text: 'What is an engine?', link: '/engines/' },
        engineSidebar('workorder', 'Work orders'),
        engineSidebar('invoicing', 'Invoicing'),
        engineSidebar('protocol', 'Protocols'),
      ],
    },
    {
      text: 'Package reference',
      items: [
        { text: '@substrat-run/contracts', link: '/reference/contracts' },
        { text: '@substrat-run/kernel', link: '/reference/kernel' },
        { text: '@substrat-run/adapter-sqlite', link: '/reference/adapter-sqlite' },
        { text: '@substrat-run/adapter-cloudflare', link: '/reference/adapter-cloudflare' },
        { text: '@substrat-run/contract-tests', link: '/reference/contract-tests' },
      ],
    },
  ];
}

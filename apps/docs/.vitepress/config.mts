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

    search: {
      provider: 'local',
    },

    footer: {
      message: 'The hard parts, hosted.',
    },
  },
}));

function guideSidebar() {
  return [
    {
      text: 'Introduction',
      items: [
        { text: 'What is Substrat?', link: '/guide/what-is-substrat' },
        { text: 'Why runtime enforcement?', link: '/guide/why-substrat' },
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Getting started', link: '/guide/getting-started' },
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
        { text: 'Work orders', link: '/engines/workorder' },
        { text: 'Invoicing', link: '/engines/invoicing' },
        { text: 'Protocols', link: '/engines/protocol' },
      ],
    },
    {
      text: 'Package reference',
      items: [
        { text: '@substrat-run/contracts', link: '/reference/contracts' },
        { text: '@substrat-run/kernel', link: '/reference/kernel' },
        { text: '@substrat-run/adapter-sqlite', link: '/reference/adapter-sqlite' },
        { text: '@substrat-run/contract-tests', link: '/reference/contract-tests' },
      ],
    },
  ];
}

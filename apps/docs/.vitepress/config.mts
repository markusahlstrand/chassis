import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(defineConfig({
  title: 'Chassis',
  description:
    'The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.',
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-chassis', activeMatch: '/guide/' },
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
        { text: 'What is Chassis?', link: '/guide/what-is-chassis' },
        { text: 'Why runtime enforcement?', link: '/guide/why-chassis' },
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Building for AI agents', link: '/guide/ai-agents' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Tenants & scopes', link: '/concepts/tenancy' },
        { text: 'Operations & the scope host', link: '/concepts/scope-host' },
        { text: 'Permissions', link: '/concepts/permissions' },
        { text: 'Events & audit', link: '/concepts/events' },
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
      ],
    },
    {
      text: 'Package reference',
      items: [
        { text: '@chassis/contracts', link: '/reference/contracts' },
        { text: '@chassis/kernel', link: '/reference/kernel' },
        { text: '@chassis/adapter-sqlite', link: '/reference/adapter-sqlite' },
        { text: '@chassis/contract-tests', link: '/reference/contract-tests' },
      ],
    },
  ];
}

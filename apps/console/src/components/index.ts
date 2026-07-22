// The console's design-system primitives now live in the shared @substrat-run/ui
// package (extracted so the dashboard reuses the exact same components). This
// barrel keeps the console's `../components` import paths working unchanged.
export * from '@substrat-run/ui';

// Learning Modules is still being built out and isn't ready for public launch
// until October. This flag is tied to the environment rather than a manual
// on/off switch, so it's automatically visible while developing locally but
// automatically hidden on the live production site — nothing to remember to
// toggle back before pushing. When ready to launch publicly, change this to
// a plain `export const MODULES_ENABLED = true` and redeploy.
export const MODULES_ENABLED = process.env.NODE_ENV !== 'production'

/** Ambient types for CSS module imports in this package. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

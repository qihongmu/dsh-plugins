/** CSS-module import face for the external client package. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

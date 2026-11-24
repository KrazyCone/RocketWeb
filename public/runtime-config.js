/**
 * Runtime configuration for the in-browser OpenRocket instance.
 *
 * Edit this file to change what the page boots -- no rebuild step is involved.
 * The CheerpJ build itself is selected by the <script> tag in index.html.
 */
window.ORWEB_CONFIG = {
  /**
   * Java runtime version handed to cheerpjInit({ version }).
   * OpenRocket 24.12 is built for Java 17, so this must be 17 (or newer).
   * OpenRocket 23.09 and earlier run on Java 11; 15.03 runs on Java 8.
   */
  javaVersion: 17,

  /** CheerpJ's /app/ mount is the root of this site. */
  jarPath: "/app/OpenRocket.jar",

  /**
   * JVM system properties, in CheerpJ's "key=value" form (no -D prefix).
   *
   * openrocket.3d.disable     OpenRocket's 3D views need native OpenGL
   *                           bindings (LWJGL/JOGL) that cannot run in
   *                           WebAssembly; the engine can abort startup with
   *                           "Error starting OpenRocket".
   * openrocket.ignore-jre     Skip OpenRocket's desktop JRE version check; the
   *                           runtime here is fixed by CheerpJ.
   * openrocket.debug.prefs    In-memory preferences instead of the real store
   *                           (java.util.prefs has no backing store in the
   *                           browser).
   */
  javaProperties: [
    "openrocket.3d.disable=true",
    "openrocket.ignore-jre=true",
    "openrocket.debug.prefs=true",
  ],

  /** Written by scripts/fetch-openrocket.mjs; used for the version badge. */
  versionManifest: "openrocket-version.json",

  /** Element that cheerpjCreateDisplay() fills. */
  displayElementId: "display",
};

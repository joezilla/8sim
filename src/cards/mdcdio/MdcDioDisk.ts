/**
 * Backward-compat shim. The floppy-disk backend now lives in the shared
 * `src/cards/floppy/` module (used by both the MDC-DIO and FIF controllers).
 * This file re-exports it under the original `MdcDio*` names so existing
 * imports keep resolving.
 */
export {
  GEOMETRIES,
  SECTOR_SIZE,
  FORMAT_FILL,
  imageSize,
  trackLength,
  FloppyRangeError as MdcDioRangeError,
  InMemoryFloppyDisk as InMemoryMdcDioDisk,
} from '../floppy/FloppyDisk.js';
export type {
  GeometrySpec,
  FloppyDisk as MdcDioDisk,
  FloppyGeometry as MdcDioGeometry,
} from '../floppy/FloppyDisk.js';

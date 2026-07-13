/* Author: Jim Battle, 2004
 *
 * these routines interpret the disk data blocks on the assumption
 * that they contain a PTDOS formatted file system.
 * there are routines to list files and to extract files.
 */

#ifndef _HELIOS_PTDOS_H_
#define _HELIOS_PTDOS_H_

#include "helios.h"

// a header is printed after this many files
#define FILES_PER_DIR_HEADER 30

// flags to pass to ptdos_disk_decode
#define DISK_QUICKDIR  0x0001	// brief directory listing
#define DISK_DIRECTORY 0x0002	// full directory listing
#define DISK_EXTRACT   0x0004	// extract files
#define DISK_XHEX      0x0008	// extract to a hex image (force extract)
#define DISK_XIMAGE    0x0010	// extract binary image (force hex and extract)
#define DISK_FILECHECK 0x0100	// check files and report errors

// list/extract specified files
void ptdos_disk_decode(svh_disk_t *disk, int action, char *filespec);

#endif // _HELIOS_PTDOS_H_

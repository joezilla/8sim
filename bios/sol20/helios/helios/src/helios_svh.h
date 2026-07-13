/* Author: Jim Battle, 2004
 * read and write ".SVH" format files.
 * SVH files are a helios disk image compatible with the Solace emulator.
 */

#ifndef _HELIOS_SVH_H_
#define _HELIOS_SVH_H_

#include "helios.h"

// read the first line of the file and attempt to classify it
int file_is_svh(const char *filename);

// read the specified file and dump it into the disk data structure.
// return 0 if OK.
int read_svh_file(const char *filename, svh_disk_t *disk);

// dump .byt disk image
// return 0 on success, !=0 on failure
int dump_svh_file(const char *filename, svh_disk_t *disk);

#endif // _HELIOS_SVH_H_

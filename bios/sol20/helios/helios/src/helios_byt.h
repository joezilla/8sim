/* Author: Jim Battle, 2004
 *
 * read and write ".BYT" format files.
 * BYT files are a helios disk image, containing all the decoded bytes
 * for each header and data block, along with a bit of metadata.
 */

#ifndef _HELIOS_BYT_H_
#define _HELIOS_BYT_H_

#include "helios.h"

// read the first line of the file and attempt to classify it
int file_is_byt(const char *filename);

// read the specified file and dump it into the disk data structure.
// return 0 if OK.
int read_byt_file(const char *filename, svh_disk_t *disk);

// dump .byt disk image
// return 0 on success, !=0 on failure
int dump_byt_file(const char *filename, svh_disk_t *disk);

#endif // _HELIOS_BYT_H_

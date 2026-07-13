// Author: Jim Battle, 2004

#ifndef _HELIOS_H_
#define _HELIOS_H_

#include "types.h"

// ========================================================================
// disk parameters
// ========================================================================

// disk properties
#define TRACKS   (77)  // tracks per disk
#define HSECTORS (32)  // hard sectors per disk
#define SECTORS  (16)  // logical sectors per disk

// ========================================================================
// utility functions
// ========================================================================

// just like malloc, but exits with error msg if malloc fails
void* safe_malloc(size_t bytes);

// remove trailing spaces, tabs, carriage returns, and newlines
void strip_line_ending(char *p);

// return NULL on failure, pointer to static buffer otherwise
// maximum length capture is 200 chars.
char *get_first_line_of_file(const char *filename);

// append the source string to the destination string.
// a "\n" is appended to the end of both.
void label_append(char **d, char *s);

// send "LABEL blah blah blah" lines to specified RAW or BYT file
void label_emit(FILE *fp, char *label);

// ========================================================================
// decoded disk format; can hold .SVT or .BYT data
// ========================================================================

// store one disk's worth of data
typedef struct {
    struct {
	int   hdr_error;	// 0=OK, !=0 is error in decoding
	int   hdr_bytes;	// size of header block (0 if none)
	uint8 *header;		// header block
	int   data_error;	// 0=OK, !=0 is error in decoding
	int   data_bytes;	// size of data block (0 if none)
	uint8 *data;		// associated data
    } sector[SECTORS];
} trk_t;

typedef struct {
    char  *label;	// disk label; can be multiline (\n separators)
    trk_t trk[TRACKS];
} svh_disk_t;

// init and free a decoded disk data structure
void disk_init(svh_disk_t *disk);
void disk_free(svh_disk_t *disk);

#endif // _HELIOS_H_

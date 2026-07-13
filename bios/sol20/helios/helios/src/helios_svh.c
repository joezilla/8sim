/* Author: Jim Battle, 2004
 *
 * read and write ".SVH" format files.
   SVH files are a helios disk image compatible with the Solace emulator.
*/

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <assert.h>

#include "helios.h"
#include "helios_svh.h"
#include "vdisk_svh_lib.h"

// ========================================================================
// read .svh disk image from file and process it
// return 0 on success, !=0 on failure
// ========================================================================

// read the first line of the file and attempt to classify it
int
file_is_svh(const char *filename)
{
    char *line = get_first_line_of_file(filename);
    return (line != NULL) && (strcmp(line,SVH_MAGIC_STR) == 0);
}


int
read_svh_file(const char *filename, svh_disk_t *disk)
{
    svd_t svd;	// info about file
    int t, s;	// track, sector
    int stat;	// return status
    int i;
    char buff[4096];

    if (!file_is_svh(filename))
	return 1;

    stat = svd_read_file_header(filename, &svd);
    if (stat != SVD_OK)
	return stat;

    // make sure the disk structure is reasonable
    if ( (svd.sides   != 1)      ||
	 (svd.tracks  != TRACKS) ||
	 (svd.sectors != SECTORS) )
	return -1;

    label_append( &(disk->label), svd.label );

    for(t=0; t<TRACKS; t++) {
	for(s=0; s<SECTORS; s++) {
	    int bytes;
	    char *mem;

	    stat = svh_read_sec_header(&svd, t, s, &bytes, buff);
	    switch (stat) {
		case SVD_BADFORMAT:
		    continue;	// no header on this sector
		case SVD_BADCRC:
		case SVD_OK:
		    break;
		default:
		    fprintf(stderr, "Trouble reading track %d, sector %d of '%s'\n",
				t, s, filename);
		    return 1;
	    }
	    mem = safe_malloc(bytes);
	    memcpy(mem, buff, bytes);
	    disk->trk[t].sector[s].hdr_error = (stat == SVD_BADCRC);
	    disk->trk[t].sector[s].hdr_bytes = bytes;
	    disk->trk[t].sector[s].header    = mem;

	    stat = svh_read_blk_data(&svd, t, s, &bytes, buff);
	    switch (stat) {
		case SVD_BADFORMAT:
		    continue;	// no data in this sector
		case SVD_BADCRC:
		case SVD_OK:
		    break;
		default:
		    fprintf(stderr, "Trouble reading track %d, sector %d of '%s'\n",
				t, s, filename);
		    return 1;
	    }
	    mem = safe_malloc(bytes);
	    memcpy(mem, buff, bytes);
	    disk->trk[t].sector[s].data_error = (stat == SVD_BADCRC);
	    disk->trk[t].sector[s].data_bytes = bytes;
	    disk->trk[t].sector[s].data       = mem;
	}
    }

    return 0;  // OK
}

// ========================================================================
// dump .svh disk image
// return 0 on success, !=0 on failure
// ========================================================================

int
dump_svh_file(const char *filename, svh_disk_t *disk)
{
    const int write_prot = 0;
    char *label = (disk->label != NULL) ? disk->label : "";
    svd_t svd;
    int t, s;	// track, sector
    int i, stat;

    assert(disk != NULL);
    assert(filename != NULL);

    stat = svh_format(filename, write_prot, label);
    if (stat != SVD_OK) {
	fprintf(stderr, "Error formatting virtual disk '%s'\n", filename);
	return 1;
    }

    stat = svd_read_file_header(filename, &svd);
    if (stat != SVD_OK)
	return 1;

    for(t=0; t<TRACKS; t++) {
	for(s=0; s<SECTORS; s++) {

	    int hdr_err    = disk->trk[t].sector[s].hdr_error;
	    int hdr_bytes  = disk->trk[t].sector[s].hdr_bytes;
	    int data_err   = disk->trk[t].sector[s].data_error;
	    int data_bytes = disk->trk[t].sector[s].data_bytes;

	    // dump header block
	    if (hdr_bytes != 0) {
		assert(hdr_bytes == SVH_HDRSIZE);
		stat = svh_write_sec_header(&svd, t, s, hdr_err,
					    disk->trk[t].sector[s].header);
		if (stat != SVD_OK) {
		    fprintf(stderr, "Error writing header to track %d, sector %s of '%s'\n",
			    t, s, filename);
		    return 1;
		}
	    }

	    // dump data block
	    if (data_bytes != 0) {
		stat = svh_write_blk_data(&svd, t, s, data_err, data_bytes,
					  disk->trk[t].sector[s].data);
		if (stat != SVD_OK) {
		    fprintf(stderr, "Error writing data to track %d, sector %s of '%s'\n",
			    t, s, filename);
		    return 1;
		}
	    }

	} // for(s)
    } // for(t)

    return 0;	// success
}

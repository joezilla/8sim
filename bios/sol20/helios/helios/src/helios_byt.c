/* Author: Jim Battle, 2004

   read and write ".BYT" format files.
   BYT files are a helios disk image, containing all the decoded bytes
   for each header and data block, along with a bit of metadata.

   BYT is useful while working on routines for converting to other formats
   or debugging the PTDOS (and maybe CP/M in the future) file extraction
   code.  FM decoding the large RAW files takes a fair amount of time on
   my poor old CPU.

   BYT files have this structure:
     HELIOS bytes                 (first line)
     # blah blah blah             (optional comments)
     LABEL first line of label    (optional)
     LABEL second line of label   (optional)
     HEADER t s b e               (t=track, s=sector, b=bytes, e=error)
     hh hh hh hh ...              (n hex bytes of header)
     DATA t s b e                 (t=track, s=sector, b=bytes, e=error)
     hh hh hh hh ...              (n hex bytes of data)
*/

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <assert.h>

#include "helios.h"
#include "helios_byt.h"

// ========================================================================
// read .byt disk image from file and process it
// return 0 on success, !=0 on failure
// ========================================================================

// read the first line of the file and attempt to classify it
int
file_is_byt(const char *filename)
{
    char *line = get_first_line_of_file(filename);
    return (line != NULL) && (strcmp(line,"HELIOS bytes") == 0);
}

// read either a HEADER or DATA block, returning a malloc'd
// array with the contents along with meta data.
// return 0 if OK.
static int
read_byt_block(FILE *fp, char *line, svh_disk_t *disk)
{
    char tag[20];	// HEADER or DATA
    char p[300];	// buffer for holding scanf
    char *mem = NULL;	// header or data block
    int t, s, b, e;	// parsed parameters
    int i;

    if (sscanf(line, "%s %d %d %d %d", tag, &t, &s, &b, &e) != 5) {
	fprintf(stderr, "ERROR: bad format, line\n\t'%s'\n", line);
	return 1;
    }
    if (t < 0 || t >= TRACKS  ||
	s < 0 || s >= SECTORS ||
	b < 0 || b >  4095    ||
	e < 0 || e >  1) {
	fprintf(stderr, "ERROR: bad file format, block\n\t'%s'\n", line);
	return 1;
    }

    mem = (char*)safe_malloc(b);

    // now suck down 'b' bytes of ascii hex bytes
    for(i=0; i<b; i++) {
	int byte;
	if (fscanf(fp, "%s", p) != 1) {
	    fprintf(stderr, "Error: bad format file\n");
	    free(mem);
	    return 1;
	}
	byte = (int)strtol(p, (char**)NULL, 16);
	if (byte < 0 || byte > 255) {
	    fprintf(stderr, "\nError: illegal byte value %s\n", p);
	    free(mem);
	    return 1;
	}
	mem[i] = byte;
    }

    if (tag[0] == 'H') {
	// HEADER
	if (disk->trk[t].sector[s].header != NULL) {
	    fprintf(stderr, "ERROR: track %d, sector %d header specified twice\n", t, s);
	    free(mem);
	    return 1;
	}
	disk->trk[t].sector[s].hdr_error = e;
	disk->trk[t].sector[s].hdr_bytes = b;
	disk->trk[t].sector[s].header    = mem;
    } else {
	// DATA
	if (disk->trk[t].sector[s].data != NULL) {
	    fprintf(stderr, "ERROR: track %d, sector %d data specified twice\n", t, s);
	    free(mem);
	    return 1;
	}
	disk->trk[t].sector[s].data_error = e;
	disk->trk[t].sector[s].data_bytes = b;
	disk->trk[t].sector[s].data       = mem;
    }

    return 0;
}

int
read_byt_file(const char *filename, svh_disk_t *disk)
{
    char line[300];		// holds line to parse
    int track, i;
    int lines = 0;
    FILE *fp;

    if (!file_is_byt(filename))
	return 1;

    fp = fopen(filename, "r");
    assert(fp != NULL);

    while (fgets(line, sizeof(line)-1, fp) != NULL) {

	int  idx_start[SECTORS+1];	// starting offset of given track
	int fast, slow;			// mean value of fast and slow edges, from histogram
	int failure;

	lines++;

	strip_line_ending(line);

	// the first line has the magic string
	if ((lines == 1) && (strcmp(line,"HELIOS bytes") == 0))
	    continue;

	if (line[0] == '\0' ||	// blank line
	    line[0] == '#')	// comment line
	    continue;

	if (strncmp(line, "LABEL ", 6) == 0) {
	    label_append( &(disk->label), &line[6] );
	    continue;
	}

	if ( (strncmp(line, "HEADER ", 7) == 0) ||
	     (strncmp(line, "DATA ",   5) == 0) ) {
	    if (read_byt_block(fp, line, disk) != 0) {
		fclose(fp);
		return 1;
	    }
	    continue;
	}

	fprintf(stderr, "ERROR: file format, unknown line\n\t'%s'\n", line);
	fclose(fp);
	return 1;

    } // while()

    return 0;  // OK
}

// ========================================================================
// dump .byt disk image
// return 0 on success, !=0 on failure
// ========================================================================

int
dump_byt_file(const char *filename, svh_disk_t *disk)
{
    FILE *fp;
    int t, s, i;

    assert(disk != NULL);

    fp = fopen(filename, "w");
    if (!fp) {
	fprintf(stderr, "Error opening file '%s' for writing\n", filename);
	return 1;
    }

    fprintf(fp, "HELIOS bytes\n");
    label_emit(fp, disk->label);

    for(t=0; t<TRACKS; t++) {
	for(s=0; s<SECTORS; s++) {

	    int hdr_err    = disk->trk[t].sector[s].hdr_error;
	    int hdr_bytes  = disk->trk[t].sector[s].hdr_bytes;
	    int data_err   = disk->trk[t].sector[s].data_error;
	    int data_bytes = disk->trk[t].sector[s].data_bytes;

	    // dump header block
	    if (hdr_bytes != 0) {
		fprintf(fp, "HEADER %d %d %d %d\n", t, s, hdr_bytes, hdr_err);
		for(i=0; i<hdr_bytes; i++) {
		    fprintf(fp, "%02X ", disk->trk[t].sector[s].header[i]);
		    if (i%16 == 15)
			fprintf(fp, "\n");
		}
		if (hdr_bytes%16 != 0)
		    fprintf(fp, "\n");
	    }

	    // dump data block
	    if (data_bytes != 0) {
		fprintf(fp, "DATA %d %d %d %d\n", t, s, data_bytes, data_err);
		for(i=0; i<data_bytes; i++) {
		    fprintf(fp, "%02X ", disk->trk[t].sector[s].data[i]);
		    if (i%16 == 15)
			fprintf(fp, "\n");
		}
		if (data_bytes%16 != 0)
		    fprintf(fp, "\n");
	    }

	} // for(s)
    } // for(t)

    fclose(fp);
    return 0;	// success
}

/*
 *    HELIOS -- utility program to
 *               read Helios/PTDOS formatted disks using a Catweasel card
 *               create virtual disk images
 *               extract specified files from either real or virtual disks
 *
 *    Copyright (C) 2004, Jim Battle, frustum@pacbell.net (as of 2/2004)
 *
 *    helios_raw.c based on:
 *        cw2dmk: Dump floppy disk from Catweasel to .dmk format.
 *        Copyright (C) 2000 Timothy Mann
 *        Id: cw2dmk.c,v 1.28 2003/06/19 05:53:28 mann Exp $
 *        Depends on Linux Catweasel driver code by Michael Krause
 *
 *    This program is free software; you can redistribute it and/or modify
 *    it under the terms of the GNU General Public License as published by
 *    the Free Software Foundation; either version 2 of the License, or
 *    (at your option) any later version.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU General Public License for more details.
 *
 *    You should have received a copy of the GNU General Public License
 *    along with this program; if not, write to the Free Software
 *    Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307,
 *    USA.
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <assert.h>
#include <stdarg.h>	// usage() varargs

#include "helios.h"
#include "helios_raw.h"
#include "helios_byt.h"
#include "helios_ptdos.h"

#include "cwfloppy.h"
#include "cwpci.h"
#include "wildcard.h"	// for filename pattern matching

// ========================================================================
// utility functions
// ========================================================================

// just like malloc, but exits with error msg if malloc fails
void *
safe_malloc(size_t bytes)
{
    void *p = NULL;

    assert(bytes >= 0);

    p = (void*)malloc(bytes);
    if (p == NULL) {
	fprintf(stderr, "Trouble allocating %d bytes of memory ... sorry!\n", bytes);
	exit(-1);
    }
    return p;
}

// remove trailing spaces, tabs, carriage returns, and newlines
void
strip_line_ending(char *p)
{
    int len;

    assert(p != NULL);
    len = strlen(p);
    while (len > 0 &&
		(p[len-1] == '\n' ||	// newline
		 p[len-1] == '\r' ||	// return
		 p[len-1] == '\t' ||	// tab
		 p[len-1] == ' ') )	// space
	p[--len] = '\0';
}

// return NULL on failure, pointer to static buffer otherwise
// maximum length capture is 200 chars.
char *
get_first_line_of_file(const char *filename)
{
    static char line[200];
    int empty;

    FILE *fp = fopen(filename, "r");
    if (fp == NULL)
	return NULL;

    empty = (fgets(line, sizeof(line)-1, fp) == NULL);
    fclose(fp);
    if (empty)
	return NULL;

    strip_line_ending(line);
    return line;
}


// append the source string to the destination string.
// it is assumed that the appended string does not have \n,
// and that the original string doesn't end in \n, so we
// put one between them.
void
label_append(char **d, char *s)
{
    char *p = NULL;
    int dlen, slen;

    assert(s != NULL);
    assert(d != NULL);

    // allocate space to hold both strings
    slen = strlen(s);
    dlen = (*d == NULL) ? 0 : strlen(*d);
    p = safe_malloc(slen + dlen + 3);  // +3 for \r\n\0

    if (*d == NULL) {
	// first line of label
	strcpy(p, s);
    } else {
	// concatenate them
	strcpy(p, *d);
	strcpy(p+dlen, "\r\n");
	strcpy(p+dlen+1, s);
    }

    // free old one, replace with new one
    if (*d == NULL) {
	*d = p;
    } else {
	free(*d);
	*d = p;
    }
}

// send "LABEL blah blah blah" lines to specified RAW or BYT file
void
label_emit(FILE *fp, char *label)
{
    char *s, *e, *p;	// start, end
    int len;

    assert(fp != NULL);

    if (label == NULL)	// no label on disk
	return;
    len = strlen(label);

    s = &label[0];
    e = &label[len];	// points at terminating \0 byte
    for(p=s; p<e; p++) {
	if ( (*p == '\r') ||	// end of a line
	     (*p == '\n') ||	// end of a line
	     (p == e-1)) {	// in case it doesn't end in \n
	    int k = p-s+1	  // length of label line ...
		  - (*p == '\r'); // ... not counting \r
		  - (*p == '\n'); // ... not counting \n
	    char *m = safe_malloc(k+1);	// +1 for null
	    if (k > 0)
		strncpy(m, s, k);
	    m[k] = '\0';
	    fprintf(fp, "LABEL %s\n", m);
	    free(m);
	    if (p[0] == '\r' && p[1] == '\n') // skip pair
		p++;
	    s = p+1;	// mark start of next line
	}
    }
}


// ========================================================================
// svh_disk_t operations
// ========================================================================

void
disk_init(svh_disk_t *disk)
{
    int t, s;

    disk->label = NULL;

    for(t=0; t<TRACKS; t++) {
	trk_t *trk = &(disk->trk[t]);
	for(s=0; s<SECTORS; s++) {
	    trk->sector[s].hdr_bytes =
	    trk->sector[s].data_bytes = 0;
	    trk->sector[s].header =
	    trk->sector[s].data = NULL;
	}
    }
}

void
disk_free(svh_disk_t *disk)
{
    int t, s;

    if (disk->label != NULL)
	free(disk->label);

    for(t=0; t<TRACKS; t++)
    for(s=0; s<SECTORS; s++) {
	if (disk->trk[t].sector[s].header != NULL)
	    free(disk->trk[t].sector[s].header);
	if (disk->trk[t].sector[s].data != NULL)
	    free(disk->trk[t].sector[s].data);
    }

    disk_init(disk);
}

// ========================================================================
// main routine
// ========================================================================

void
usage(const char *fmt, ...)
{
    char buff[1000];
    va_list args;

    // print optional reason for error message
    if (fmt != NULL) {
	va_start(args, fmt);
	vsprintf(buff, fmt, args);
	va_end(args);
	fprintf(stderr, "Error: %s\n", buff);
    }

    // FIXME: add version string
    // FIXME: add help flag (-h, -?)
    // FIXME?: "-X" is a legal PTDOS filename.  thus
    //             helios foo.raw -X
    //        might be a request to extract everything,
    //        or to dir entries that match "-X".

    fprintf(stderr,
	"helios command summary:\n"
	"    Print directory of files matching optional spec:\n"
	"        helios <src> [<spec>]\n"
	"    Extract specific files matching optional spec:\n"
	"        helios <src> [<spec>] -{x|xh|xi}\n"
	"    Use -x to extract as binary, -xh as intel hex; use -xi for program images\n"
	"    Check integrity of files matching optional spec:\n"
	"        helios <src> [<spec>] -c\n"
	"    Convert <scr> to one or more disk image files:\n"
	"        helios <src> [-r foo.raw] [-b foo.byt] [-v foo.svh] [-l \"label\"]\n"
	"    <src> is one of:\n"
	"        /n           -- disk drive n (0-3) on the attached catweasel card\n"
	"        filename.raw -- unprocessed dump of bit transition timings, by track\n"
	"        filename.byt -- header and data bytes FM decoded by track and sector\n"
	"        filename.svh -- Solace virtual disk image\n"
	"    <spec> is an optional filename wildcard pattern:\n"
	"        ? matches any single character\n"
	"        * matches any sequence of characters\n"
	"        all other characters match just one literal character\n"
	"Notes:\n"
	"    A .raw file can only be produced from a real disk.\n"
	"    Use multiple \"-l\"s for multiline labels with -r, -b, -v.\n"
	"    Beware that the shell might expand the wildcard; put it in quotes.\n"
    );
    exit(-1);
}


int
main(int argc, char** argv)
{
    svh_disk_t *disk = NULL;	// holds decoded disk
    char *pSrcFile   = NULL;	// source file to read (NULL if disk)
    char *pSpec      = NULL;	// filename spec
    char *pRFile     = NULL;	// name to save .RAW file to
    char *pBFile     = NULL;	// name to save .BYT file to
    char *pVFile     = NULL;	// name to save .SVH file to
    char *pLabel     = NULL;	// label specified on command line
    int   xflag      =  0;	// -x file extract flag
    int   xiflag     =  0;	// -xi file extract flag
    int   xhflag     =  0;	// -xh file extract flag
    int   cflag      =  0;	// -c file check flag
    int   disk_unit  = -1;	// >=0 indicates to read from disk
    int   rv = 0;		// return value from program
    int   dir, qdir;		// whether dir action is requested
    int   i;

    // ====== parse arguments ======

    if (argc < 2)
	usage(NULL);

    if (!strcmp(argv[1],"-ver") ||
	!strcmp(argv[1],"--ver") ||
	!strcmp(argv[1],"-version") ||
	!strcmp(argv[1],"--version")) {
	fprintf(stderr, "Aug 22, 2004\n");
	exit(0);
    }

    // see if a drive (/0 /1 /2 /3) was specified
    i = 1;
    if ((argv[i][0] == '/') && (strlen(argv[i]) == 2)) {
	if (argv[i][1] < '0' || argv[i][1] > '3')
	    usage("Disk unit must be from 0 to 3, not %c", argv[i][1]);
	disk_unit = argv[i][1] - '0';
	i++;
    }

    // if "disk" wasn't specified, it must be a file name
    if (disk_unit < 0) {
	pSrcFile = argv[i];
	FILE *fp = fopen(pSrcFile, "r");
	if (fp == NULL)
	    usage("Couldn't open file '%s' for reading.", pSrcFile);
	fclose(fp);
	i++;
    }

    // see if a filespec is given
    if ((argv[i][0] != '-') || (strlen(argv[i]) != 2)) {
	pSpec = argv[i];
	i++;
    }

    // scan for -flags
    while (i < argc) {

	// ignore case on the flag
	if (argv[i][0] == '-' && argv[i][1] >= 'A' && argv[i][1] <= 'Z')
	    argv[i][1] += 'a' - 'A';
	
	if (!strcmp(argv[i], "-x")) {
	    xflag = 1;	// we've seen it
	    if (++i != argc)
		usage("-x must be the last flag on the command");
	} else if (!strcmp(argv[i], "-xi")) {
	    xiflag = 1;	// we've seen it
	    if (++i != argc)
		usage("-xi must be the last flag on the command");
	} else if (!strcmp(argv[i], "-xh")) {
	    xhflag = 1;	// we've seen it
	    if (++i != argc)
		usage("-xh must be the last flag on the command");
	} else if (!strcmp(argv[i], "-c")) {
	    cflag = 1;
	    if (++i != argc)
		usage("-c must be the last flag on the command");
	} else if (!strcmp(argv[i], "-r")) {
	    if (pRFile != NULL)
		usage("-r flag can appear only once");
	    if (++i >= argc)
		usage("-r must be followed by a target file name");
	    pRFile = argv[i];	// grab associated filename
	    i++;
	} else if (!strcmp(argv[i], "-b")) {
	    if (pBFile != NULL)
		usage("-b flag can appear only once");
	    if (++i >= argc)
		usage("-b must be followed by a target file name");
	    pBFile = argv[i];	// grab associated filename
	    i++;
	} else if (!strcmp(argv[i], "-v")) {
	    if (pVFile != NULL)
		usage("-v flag can appear only once");
	    if (++i >= argc)
		usage("-v must be followed by a target file name");
	    pVFile = argv[i];	// grab associated filename
	    i++;
	} else if (!strcmp(argv[i], "-l")) {
	    if (++i >= argc)
		usage("-l must be followed by a label string");
	    label_append(&pLabel, argv[i]);
	    i++;
	} else {
	    usage("Unknown flag '%s'", argv[i]);
	}
    }

    if ((pRFile != NULL) && (disk_unit < 0))
	usage("Raw files can only be extracted from real disks");
    if ((xflag | xiflag | xhflag) &&
	(pRFile != NULL || pBFile != NULL || pVFile != NULL))
	usage("If -x is specified, -r, -b, and -v aren't allowed");
    if ((pSpec != NULL) && (pRFile != NULL || pBFile != NULL || pVFile != NULL))
	usage("If filespec is specified, -r, -b, and -v aren't allowed");

#if 0
    // check the argument parsing
    if (disk_unit >= 0)
	fprintf(stderr, "disk_unit=%d\n", disk_unit);
    fprintf(stderr, "xflag =%d\n", xflag);
    fprintf(stderr, "xiflag=%d\n", xiflag);
    fprintf(stderr, "xhflag=%d\n", xhflag);
    if (pSrcFile != NULL) fprintf(stderr, "source file is '%s'\n", pSrcFile);
    if (pSpec  != NULL) fprintf(stderr, "filespec is '%s'\n", pSpec);
    if (pRFile != NULL) fprintf(stderr, "-r file is '%s'\n", pRFile);
    if (pBFile != NULL) fprintf(stderr, "-b file is '%s'\n", pBFile);
    if (pVFile != NULL) fprintf(stderr, "-v file is '%s'\n", pVFile);
    label_emit(stderr, pLabel);
    exit(0);
#endif

    // ====== carry out requested action ======

    dir  = !cflag && (pRFile == NULL && pBFile == NULL && pVFile == NULL);
    qdir = dir && (pSrcFile == NULL);

    disk = (svh_disk_t*)safe_malloc(sizeof(svh_disk_t));

    // start with an empty disk data structure
    disk_init(disk);

    // get the starting data
    if (pSrcFile == NULL) {
	// no source file supplied, so the disk is assumed
	rv = read_disk(pRFile, pLabel, disk_unit, qdir, disk);
    } else {
	if (file_is_raw(pSrcFile)) {
	    rv = read_raw_file(pSrcFile, disk);
	} else if (file_is_byt(pSrcFile)) {
	    rv = read_byt_file(pSrcFile, disk);
	} else if (file_is_svh(pSrcFile)) {
	    rv = read_svh_file(pSrcFile, disk);
	} else {
	    fprintf(stderr, "ERROR: can't determine file format of '%s'\n", pSrcFile);
	    exit(-1);
	}
    }
    if (rv != 0) {
	// exit(rv);
	printf("WARNING: disk image might not be entirely valid\n");
    }

    // at this point we have filled the "disk" structure with the disk image

    // if the user specified a label for the disk, use that instead
    if (pLabel != NULL) {
	if (disk->label != NULL)
	    free(disk->label);
	disk->label = pLabel;
    }

    if (xflag) {
	int action = DISK_EXTRACT | DISK_FILECHECK;
	ptdos_disk_decode(disk, action, pSpec);
    } else if (xhflag) {
	int action = DISK_EXTRACT | DISK_XHEX | DISK_FILECHECK;
	ptdos_disk_decode(disk, action, pSpec);
    } else if (xiflag) {
	int action = DISK_EXTRACT | DISK_XHEX | DISK_XIMAGE | DISK_FILECHECK;
	ptdos_disk_decode(disk, action, pSpec);
    } else if (cflag) {
	int action = DISK_FILECHECK;
	ptdos_disk_decode(disk, action, pSpec);
    } else if (dir) {
	int action = (0 || qdir) ? DISK_QUICKDIR : DISK_DIRECTORY;
	ptdos_disk_decode(disk, action, pSpec);
    }

    if (pBFile != NULL) {
	// dump to decoded byte file
	rv = dump_byt_file(pBFile, disk);
	if (rv != 0) {
	    fprintf(stderr, "Error dumping .byt file -- aborting!\n");
	    exit(rv);
	}
    }

    if (pVFile != NULL) {
	// dump to Solace virtual disk file
	rv = dump_svh_file(pVFile, disk);
	if (rv != 0) {
	    fprintf(stderr, "Error dumping .svh file -- aborting!\n");
	    exit(rv);
	}
    }

    disk_free(disk);
    disk = NULL;

    return 0;
}

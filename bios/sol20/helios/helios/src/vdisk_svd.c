// Author: Jim Battle, 2004
// Common virtual disk access functions.

#include <io.h>		// for open() and friends
#include <fcntl.h>	// for open() and friends
#include <sys/stat.h>	// for open() and friends
#include <string.h>
#include <assert.h>

#include "vdisk_svd.h"

// return a descriptive string to decipher numeric error code
char *
vdisk_errstring(int err)
{
    switch (err) {
	case SVD_OK:		return "everything is OK";
	case SVD_FILEEXISTS:	return "file already exists on disk";
	case SVD_NOFILE:	return "requested file doesn't exist";
	case SVD_BADFILE:	return "bad file format";
	case SVD_OPENERROR:	return "couldn't open file";
	case SVD_ACCESSERROR:	return "couldn't read or write to file";
	case SVD_BADFORMAT:	return "the format of this disk is wrong";
	default:
	    break;
    }
    return "impossible error code";
}


// given a filename, read the header into an svd struct
int
svd_read_file_header(const char *filename, svd_t *svd)
{
    svd_header_t hdr_block;
    int fd, stat;

    assert(sizeof(svd_header_t) == SVD_HDR_SIZE);

    fd = open(filename, _O_RDONLY | _O_BINARY, 0);
    if (fd == -1)
	return SVD_OPENERROR;

    // read header block
    stat = read(fd, (char*)&hdr_block, SVD_HDR_SIZE);
    close(fd);
    if (stat == -1)
	return SVD_ACCESSERROR;

    // validate and copy each parameter from the header to the svd_t

    if ( (strcmp(hdr_block.format, SVN_MAGIC_STR) == 0) &&
         (hdr_block.version == 1) ) {
	svd->format = SVD_FORMAT_SVN;
    } else if ( (strcmp(hdr_block.format, SVH_MAGIC_STR) == 0) &&
		(hdr_block.version == 1) ) {
	svd->format = SVD_FORMAT_SVH;
    } else
	return SVD_BADFORMAT;

    svd->writeprot = hdr_block.writeprot;
    svd->density   = hdr_block.density;
    svd->sides     = hdr_block.sides;
    svd->tracks    = hdr_block.tracks;
    svd->sectors   = hdr_block.sectors;
    memset(svd->label, 0, SVD_LABEL_SIZE);		// makes gdb "print svd" more sane
    hdr_block.label[SVD_LABEL_SIZE-1] = '\0';	// just in case
    strcpy(svd->label, hdr_block.label);

    if (hdr_block.writeprot != 0 && hdr_block.writeprot != 1)
	return SVD_BADFORMAT;

    switch (svd->format) {
	case SVD_FORMAT_SVN:
	    if ( (hdr_block.density != 1 && hdr_block.density != 2)
	      || (hdr_block.sides   != 1 && hdr_block.sides   != 2)
	      || (hdr_block.tracks < SVD_MINTRACKS)
	      || (hdr_block.tracks > SVD_MAXTRACKS)
	      || (hdr_block.sectors != NS_SECTORS_PER_TRACK) )
		return SVD_BADFORMAT;
	    break;
	case SVD_FORMAT_SVH:
	    if ( (hdr_block.density   != 1)
	      || (hdr_block.sides     != 1)
	      || (hdr_block.tracks    != SVH_TRACKS_PER_DISK)
	      || (hdr_block.sectors   != SVH_SECTORS_PER_TRACK) )
		return SVD_BADFORMAT;
	    break;
	default:
	    assert(0);
    }

    // save filename so we can open it again later
    strcpy(svd->filename, filename);

    return 0;
}


// modify the header block on the virtual disk without otherwise
// affecting the rest of the virtual disk.
int
svd_write_file_header(svd_t *svd)
{
    svd_header_t hdr_block;
    int fd, stat, i;
    int fmode;

    assert(sizeof(svd_header_t) == SVD_HDR_SIZE);

    assert(svd->filename != NULL);
    assert(strlen(svd->filename) < SVD_FILENAME_SIZE);
    assert(svd->writeprot == 0 || svd->writeprot == 1);
    assert(svd->label != NULL);
    assert(strlen(svd->label) <= SVD_LABEL_SIZE);

    switch (svd->format) {
	case SVD_FORMAT_SVN:
	    assert(svd->sides == 1 || svd->sides == 2);
	    assert(svd->tracks >= SVD_MINTRACKS && svd->tracks <= SVD_MAXTRACKS);
	    assert(svd->density == 1 || svd->density == 2);
	    strcpy(hdr_block.format, SVN_MAGIC_STR);
	    break;
	case SVD_FORMAT_SVH:
	    assert(svd->sides == 1);
	    assert(svd->tracks == SVH_TRACKS_PER_DISK);
	    assert(svd->density == 1);
	    strcpy(hdr_block.format, SVH_MAGIC_STR);
	    break;
	default:
	    assert(0);
    }

    hdr_block.version   = 1;
    hdr_block.writeprot = svd->writeprot;
    hdr_block.density   = svd->density;
    hdr_block.sides     = svd->sides;
    hdr_block.tracks    = svd->tracks;
    hdr_block.sectors   = svd->sectors;
    strcpy(hdr_block.label, svd->label);

    // pad fields with 0x00 bytes
    for(i=strlen(hdr_block.format); i<sizeof(hdr_block.format); i++)
	hdr_block.format[i] = '\0';
    for(i=0; i<sizeof(hdr_block.pad); i++)
	hdr_block.pad[i] = '\0';
    for(i=strlen(hdr_block.label); i<sizeof(hdr_block.label); i++)
	hdr_block.label[i] = '\0';


    fmode = _O_WRONLY	// we want to write
	  | _O_BINARY;	// don't to CR/LF conversions and such
    fd = open(svd->filename, fmode, 0);
    if (fd == -1)
	return SVD_OPENERROR;

    // write header block
    stat = write(fd, (char*)&hdr_block, SVD_HDR_SIZE);
    close(fd);
    if (stat == -1)
	return SVD_ACCESSERROR;

    return SVD_OK;
}

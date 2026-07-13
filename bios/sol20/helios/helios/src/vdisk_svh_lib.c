// Author: Jim Battle, 2004
// Utility routines for manipulating SVH virtual disk images.

#include <stdio.h>
#include <stdarg.h>	// for varargs
#include <string.h>
#include <io.h>		// for open() and friends
#include <fcntl.h>	// for open() and friends
#include <sys/stat.h>	// for open() and friends
#include <memory.h>	// for memcpy()
#include <assert.h>

#include "vdisk_svh_lib.h"

// --------------- local macros -----------------

#define min(a,b) (((a)<(b)) ? (a) : (b))

// ===================================================================
//                       virtual disk structure
// ===================================================================

#define SVH_SECSIZE           (320)  // (166.67 ms / 16 sectors) * 250 Kbps
#define SVH_SECTOR_OVERHEAD   (4)
#define SVH_BLKSIZE           (SVH_SECSIZE + SVH_SECTOR_OVERHEAD)
#define SVH_HDR_OFFSET        (16) // header start in sector
#define SVH_DATA_OFFSET       (48) // data start in first sector of block

// ===================================================================
//
// ===================================================================

// this function is used to compute a byte offset within the real
// disk file that represents a given position in the emulated disk.
// if there are two sides, we store the tracks next to each other on disk
// tracks count up from 0.
// sectors count up from 0.
static int
compute_sector_pos(svd_t *svd, int track, int sector)
{
    const int side = 0;	// constant for helios
    int block;

    assert(svd    != NULL);
    assert(track  >=0 && track  < svd->tracks);
    assert(sector >=0 && sector < svd->sectors);

    block = track * (svd->sectors)*(svd->sides)
	  + side  * (svd->sectors)
	  + sector;

    return SVD_HDR_SIZE + block*SVH_BLKSIZE;
}


// read all the data associated with a sector including the metadata.
// the "bytes" value returned is the number of bytes in the data portion
// of the sector.  No matter what that field says, SVH_SECSIZE bytes of
// data is copied into the secbuf unless there is some error.  The caller
// needs to inspect the "fmt" return value to make sense of the raw bytes.
static int
svh_read_raw_sector(svd_t *svd, int track, int sector,
		    int *fmt, int *bytes, char *secbuf)
{
    int offset = compute_sector_pos(svd, track, sector);
    int fd, stat;
    unsigned char overhead[SVH_SECTOR_OVERHEAD];

    fd = open(svd->filename, _O_RDONLY | _O_BINARY, 0);
    if (fd == -1)
	return SVD_OPENERROR;

    // jump to start of specified sector
    stat = lseek(fd, offset, SEEK_SET);
    if (stat < 0) {
	close(fd);
	return SVD_ACCESSERROR;
    }

    stat = read(fd, overhead, SVH_SECTOR_OVERHEAD);
    if (stat != SVH_SECTOR_OVERHEAD) {
	close(fd);
	return SVD_ACCESSERROR;
    }

    // what is contained in the sector
    *fmt = (int)overhead[0];

    // # bytes in data portion of sector:
    *bytes = (int)overhead[1] + 256*(int)overhead[2];
    if (*fmt & SVH_FMT_HAS_DATA) {
	if (*bytes > SVH_SECSIZE) {
	    printf("WHOA: t=%d, s=%d, b=%d\n", track, sector, *bytes);
	}
	assert(*bytes <= SVH_SECSIZE);
    }

    stat = read(fd, secbuf, SVH_SECSIZE);
    close(fd);
    if (stat != SVH_SECSIZE)
	return SVD_ACCESSERROR;

    return SVD_OK;
}


// read the header a block of data, if it exists
int
svh_read_sec_header(svd_t *svd, int track, int sector,
		    int *bytes, char *secbuf)
{
    char rawbuff[SVH_SECSIZE];
    int rv, fmt;
    int data_bytes;

    rv = svh_read_raw_sector(svd, track, sector,
			     &fmt, &data_bytes, rawbuff);
    if (rv != SVD_OK)
	return rv;

    if (~fmt & SVH_FMT_HAS_HEADER)
	return SVD_BADFORMAT;	// no header on this sector

    if (fmt & SVH_FMT_CRCERR_HDR)
	return SVD_BADCRC;	// header has bad CRC

    *bytes = SVH_HDRSIZE;
    memcpy(secbuf, &rawbuff[SVH_HDR_OFFSET], *bytes);

    return SVD_OK;
}


// write a raw sector to the specified sector in the virtual disk.
// data_bytes is used in the metadata and represents the number of
// valid bytes in the data portion of the sector, but doesn't affect
// how much is actually written (it is always SVH_SECSIZE bytes).
static int
svh_write_raw_sector(svd_t *svd, int track, int sector,
		     int fmt, int data_bytes, char *secbuf)
{
    int offset = compute_sector_pos(svd, track, sector);
    int fd, stat;
    int fmode;
    char overhead[SVH_SECTOR_OVERHEAD];
    char rawbuff[SVH_SECSIZE];

    assert(rawbuff != NULL);
    assert(data_bytes <= SVH_SECSIZE);	// detect programming error

    fmode = _O_WRONLY	// we want to write
	  | _O_BINARY;	// don't to CR/LF conversions and such
    fd = open(svd->filename, fmode, 0);
    if (fd == -1)
	return SVD_OPENERROR;

    // jump to start of specified sector
    stat = lseek(fd, offset, SEEK_SET);
    if (stat < 0) {
	close(fd);
	return SVD_ACCESSERROR;
    }

    // write sector metadata
    overhead[0] = fmt;
    overhead[1] = data_bytes%256;
    overhead[2] = data_bytes/256;
    overhead[3] = 0x00;
    stat = write(fd, overhead, SVH_SECTOR_OVERHEAD);
    if (stat != SVH_SECTOR_OVERHEAD) {
	close(fd);
	return SVD_ACCESSERROR;
    }

    stat = write(fd, (char*)secbuf, SVH_SECSIZE);
    close(fd);
    if (stat != SVH_SECSIZE)
	return SVD_ACCESSERROR;

    return SVD_OK;
}


// write the header block of a sector; it must be 13 bytes, supplied in secbuf
int
svh_write_sec_header(svd_t *svd, int track, int sector, int badcrc,
		     char *secbuf)
{
    char rawbuff[SVH_SECSIZE];
    int rv, i, fmt, data_bytes;

    // get previous contents
    rv = svh_read_raw_sector(svd, track, sector,
			     &fmt, &data_bytes, rawbuff);
    if (rv != SVD_OK)
	return rv;

    // fill header padding with 0x00 bytes
    memset(&rawbuff[0], 0, SVH_DATA_OFFSET);

    // fill in header data
    for(i=0; i<SVH_HDRSIZE; i++)
	rawbuff[i+SVH_HDR_OFFSET] = secbuf[i];

    if (~fmt & SVH_FMT_HAS_HEADER) {
	// sector didn't have a header before, so we invalidate data
	fmt = SVH_FMT_HAS_HEADER; // and no data
	data_bytes = 0;
    }

    if (badcrc)
	fmt |= SVH_FMT_CRCERR_HDR;	// set it
    else
	fmt &= ~SVH_FMT_CRCERR_HDR;	// clear it

    rv = svh_write_raw_sector(svd, track, sector,
			      fmt, data_bytes, rawbuff);
    return rv;
}


// write a block of data, 1-4095 bytes starting at the specified
// sector; the block may need to span multiple sectors.
int
svh_write_blk_data(svd_t *svd, int track, int sector, int badcrc,
		   int data_bytes, char *secbuf)
{
    char rawbuff[SVH_SECSIZE];
    int sectors_spanned = 1 + ((data_bytes - 256 + (SVH_SECSIZE-1)) / SVH_SECSIZE);
    int bytes_written = 0;
    int old_fmt, old_data_bytes;
    int i;

    assert(data_bytes > 0);
    assert(data_bytes < 4096);
    assert(sector + sectors_spanned <= SVH_SECTORS_PER_TRACK);

    for(i=0; i<sectors_spanned; i++) {

	const int bytes_left     = (data_bytes - bytes_written);
	const int first_sector   = (i == 0);
	const int final_sector   = (i == sectors_spanned-1);
	const int partial_sector =  first_sector ||
				   (final_sector && (bytes_left != SVH_SECSIZE));
	int bytes_this_sector, rv, fmt;
	char *p;	// pointer to data buffer to write

	if (partial_sector) {
	    // we are going to write less than SVH_SECSIZE data bytes,
	    // so read the old contents so we can merge
	    rv = svh_read_raw_sector(svd, track, sector+i,
				     &old_fmt, &old_data_bytes, rawbuff);
	    if (rv != SVD_OK)
		return rv;
	}

	// format bits common to all cases
	fmt = SVH_FMT_HAS_DATA
	    | ((first_sector) ? SVH_FMT_FIRST_DATA  : 0)
	    | ((final_sector) ? SVH_FMT_LAST_DATA   : 0)
	    | ((badcrc)       ? SVH_FMT_CRCERR_DATA : 0);

	p = &secbuf[bytes_written];	// where next chunk of data is from

	if (first_sector) {
	    // keep old header status
	    fmt |= (old_fmt & (SVH_FMT_HAS_HEADER | SVH_FMT_CRCERR_HDR));
	    // first block has fewer bytes for storing data
	    bytes_this_sector = min(256, data_bytes);
	    memmove( &rawbuff[SVH_DATA_OFFSET], p, bytes_this_sector );
	    p = rawbuff;	// write from merged version
	} else if (!final_sector) {
	    // in the middle somewhere
	    bytes_this_sector = SVH_SECSIZE;
	} else {
	    // last sector of multi-sector block
	    fmt |= SVH_FMT_LAST_DATA;
	    bytes_this_sector = bytes_left;
	    if (bytes_this_sector <= 0 || bytes_this_sector > SVH_SECSIZE) {
		printf("WHOA: track=%d, sector=%d, data_bytes=%d, span=%d, i=%d, bytes_this=%d\n",
			track, sector, data_bytes, sectors_spanned, i, bytes_this_sector);
	    }
	    assert(bytes_this_sector > 0);
	    assert(bytes_this_sector <= SVH_SECSIZE);
	    if (bytes_this_sector < SVH_SECSIZE) {
		memmove( rawbuff, p, bytes_this_sector );
		p = rawbuff;	// write from merged version
	    }
	}

	rv = svh_write_raw_sector(svd, track, sector+i,
				  fmt, bytes_this_sector, p);
	if (rv != SVD_OK)
	    return rv;

	bytes_written += bytes_this_sector;
    }

    // FIXME: return some specific error code if the write operation
    //        wraps into sector 0?  I think the disk controller does
    //        have a status bit to indicate this.

    return SVD_OK;
}


// read a block of data; it may span multiple sectors and return up to
// 4095 bytes of data, which the caller must provide space for.
int
svh_read_blk_data(svd_t *svd, int track, int sector,
		  int *bytes, char *secbuf)
{
    char rawbuff[SVH_SECSIZE];
    int bytes_read = 0;
    int i;

    // read sector after sector until we've read the whole block or
    // hit an error.
    for(i=0; ; i++) {

	int rv, fmt, data_offset, data_bytes;

	rv = svh_read_raw_sector(svd, track, sector+i,
				    &fmt, &data_bytes, rawbuff);
	if (rv != SVD_OK)
	    return rv;

	if (~fmt & SVH_FMT_HAS_DATA)  // no data in this sector
	    return SVD_BADFORMAT;

	if ((i == 0) && (~fmt & SVH_FMT_FIRST_DATA))  // not the first block
	    return SVD_BADFORMAT;

	if (fmt & SVH_FMT_CRCERR_DATA)
	    return SVD_BADCRC;		// data has bad CRC

	if (bytes_read + data_bytes > 4095)
	    return SVD_BADFORMAT;  // we've sent an impossible amount of data

	data_offset = (fmt & SVH_FMT_HAS_HEADER) ? SVH_DATA_OFFSET : 0;

	memcpy( &secbuf[bytes_read], &rawbuff[data_offset], data_bytes );

	bytes_read += data_bytes;

	if (fmt & SVH_FMT_LAST_DATA)
	    break;	// last block to read
    }

    *bytes = bytes_read; // total # of bytes read

    return SVD_OK;
}


// create a blank virtual blank helios disk.
// return 0 if OK, otherwise some error indication.
// does not check if file already exists.
//
// The helios disk controller performed a very primitive format which
// would be followed up by a software-controlled format by the OS (PTDOS).
// The primitive format would cause each sector to be written to this state:
//     13 byte HEADER of 0xFF
//      1 byte DATA   of 0xFF
int
svh_format(const char *filename, int writeprotect, char *label)
{
    char rawsec[SVH_BLKSIZE];
    int data_bytes = 1;
    int track, sector;
    int fd, i, stat;

    assert(filename != NULL);
    assert(strlen(filename) < SVD_FILENAME_SIZE);
    assert(label != NULL);

    // create the file.  wipe it out if it already exists.
    {
	const int fmode = _O_WRONLY	// we want to write
			| _O_CREAT	// we
			| _O_TRUNC	// make it zero length
			| _O_BINARY;	// don't to CR/LF conversions and such
    //  fd = open(filename, fmode, _S_IREAD | _S_IWRITE);
	fd = open(filename, fmode, S_IREAD | S_IWRITE);
	if (fd == -1)
	    return SVD_OPENERROR;
	close(fd);
    }

    // create the virtual disk header
    {
	svd_t svd;

	memset(&svd, 0, sizeof(svd));
	strcpy(svd.filename, filename);
	svd.format    = SVD_FORMAT_SVH;	// helios
	svd.sides     = 1;		// always single sided
	svd.tracks    = SVH_TRACKS_PER_DISK;
	svd.sectors   = SVH_SECTORS_PER_TRACK;
	svd.density   = 1;		// always single density
	svd.writeprot = writeprotect;
	strncpy(svd.label, label, SVD_LABEL_SIZE);
	svd.label[SVD_LABEL_SIZE-1] = '\0';  // just in case

	stat = svd_write_file_header(&svd);
	if (stat != SVD_OK)
	    return stat;
    }

    // create image of a sector with primitive format
    memset(rawsec, 0, sizeof(rawsec));
    rawsec[0] = SVH_FMT_HAS_HEADER
	      | SVH_FMT_HAS_DATA | SVH_FMT_FIRST_DATA | SVH_FMT_LAST_DATA;
    rawsec[1] = data_bytes % 256;
    rawsec[2] = data_bytes / 256;
    for(i=0; i<SVH_HDRSIZE; i++)
	rawsec[i + SVH_SECTOR_OVERHEAD + SVH_HDR_OFFSET] = (char)0xFF;
    for(i=0; i<data_bytes; i++)
	rawsec[i + SVH_SECTOR_OVERHEAD + SVH_DATA_OFFSET] = (char)0xFF;

    // open file, skip header
    fd = open(filename, _O_WRONLY | _O_BINARY, 0);
    if (fd == -1)
	return SVD_OPENERROR;
    // jump to start of specified sector
    stat = lseek(fd, SVD_HDR_SIZE, SEEK_SET);
    if (stat < 0) {
	close(fd);
	return SVD_ACCESSERROR;
    }

    // now append N sector blocks with primitive formatting
    for(track=0; track<SVH_TRACKS_PER_DISK; track++) {
	for(sector=0; sector<SVH_SECTORS_PER_TRACK; sector++) {
	    stat = write(fd, rawsec, SVH_BLKSIZE );
	    if (stat != SVH_BLKSIZE) {
		close(fd);
		return SVD_ACCESSERROR;
	    }
	}
    }
    close(fd);

    return SVD_OK;
}

/* Author: Jim Battle, 2004
 *
 * These routines interpret the disk data blocks on the assumption
 * that they contain a PTDOS formatted file system.
 * There are routines to list files and to extract files.
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <assert.h>

#include "helios.h"
#include "helios_ptdos.h"
#include "wildcard.h"	// for filename pattern matching

// ----- macros to decode information about a block -----

#define HDR_CRCERR(dsk,t,s)  (dsk->trk[t].sector[s].hdr_error)
#define DATA_CRCERR(dsk,t,s) (dsk->trk[t].sector[s].data_error)

// header and data block sizes
#define HDR_SIZE(dsk,t,s)  (dsk->trk[t].sector[s].hdr_bytes)
#define DATA_SIZE(dsk,t,s) (dsk->trk[t].sector[s].data_bytes)

// the given sector has a header block
#define SECTOR_HAS_HDR(dsk,t,s) (HDR_SIZE(dsk,t,s) != 0)
// the given sector has a data block
#define SECTOR_HAS_DATA(dsk,t,s) (DATA_SIZE(dsk,t,s) != 0)

// pointer to header/data array
#define HDR_PTR(dsk,t,s)   (dsk->trk[t].sector[s].header)
#define DATA_PTR(dsk,t,s)  (dsk->trk[t].sector[s].data)

// ----- macros to decode information about a directory entry -----

// utility macro
#define DIR_U8(dsk,t,s,i,o) ((int)(dsk->trk[t].sector[s].data[2+21*i+(o)]))
#define DIR_U16(dsk,t,s,i,o) ((DIR_U8(dsk,t,s,i,(o+1))<<8) + DIR_U8(dsk,t,s,i,o))
// number of entries in the directory's current sector
#define DIR_NUM_ENTRIES(dsk,t,s) (dsk->trk[t].sector[s].data[0])
// offset to next free entry in directories current sector
#define DIR_NEXT_FREE_BYTE(dsk,t,s) (dsk->trk[t].sector[s].data[1])
// file type
#define DIR_FILE_TYPE(dsk,t,s,i) (DIR_U8(dsk,t,s,i,8))
// block size, in bytes (seems mostly useless; file size would be more useful)
#define DIR_BLOCK_SIZE(dsk,t,s,i) (DIR_U16(dsk,t,s,i,9))
// file protection attributes
#define DIR_FILE_PROT(dsk,t,s,i) (DIR_U8(dsk,t,s,i,11))
// unique file ID
#define DIR_FILE_ID(dsk,t,s,i) (DIR_U16(dsk,t,s,i,12))
// pointer to index file for indicated entry
#define DIR_IDX_SEC(dsk,t,s,i) (DIR_U8(dsk,t,s,i,14))
#define DIR_IDX_TRK(dsk,t,s,i) (DIR_U8(dsk,t,s,i,15))
#define DIR_HAS_INDEX(dsk,t,s,i) (DIR_IDX_SEC(dsk,t,s,i)!=0x00 || DIR_IDX_TRK(dsk,t,s,i)!=0x00)
// pointer to start of file
#define DIR_FILE_SEC(dsk,t,s,i) (DIR_U8(dsk,t,s,i,16))
#define DIR_FILE_TRK(dsk,t,s,i) (DIR_U8(dsk,t,s,i,17))
// number of blocks required to hold file
#define DIR_FILE_BLKS(dsk,t,s,i) (DIR_U16(dsk,t,s,i,18))
// return pointer to filename (caution -- it's a ptr to static buffer)
static char *
DIR_FILE_NAME(svh_disk_t *dsk, int t, int s, int i)
{
    static char name[9];
    int n;
    for(n=0; n<8; n++)
	name[n] = DIR_U8(dsk,t,s,i,n) & 0x7F;  // msb is ignored
    name[8] = '\0';
    return name;
}

// ----- macros to decode information about a header -----

// utility macro
#define HDR_U8(dsk,t,s,o) ((int)(dsk->trk[t].sector[s].header[o]))
#define HDR_U16(dsk,t,s,o) ((HDR_U8(dsk,t,s,(o+1))<<8) + HDR_U8(dsk,t,s,o))
// the number of bytes in the data block
// FIXME: == DATA_SIZE()
#define BLK_DATA_BYTES(dsk,t,s) (dsk->trk[t].sector[s].data_bytes)
// next current track and sector
#define HDR_SEC(dsk,t,s) HDR_U8(dsk,t,s,0)
#define HDR_TRK(dsk,t,s) HDR_U8(dsk,t,s,1)
// next track and sector
#define HDR_NXT_SEC(dsk,t,s) HDR_U8(dsk,t,s,2)
#define HDR_NXT_TRK(dsk,t,s) HDR_U8(dsk,t,s,3)
// previous track and sector
#define HDR_PREV_SEC(dsk,t,s) HDR_U8(dsk,t,s,4)
#define HDR_PREV_TRK(dsk,t,s) HDR_U8(dsk,t,s,5)
// file ID
#define HDR_FILE_ID(dsk,t,s) HDR_U16(dsk,t,s,6)
// block length, in sectors and bytes
#define HDR_SECTORS(dsk,t,s) HDR_U8(dsk,t,s,8)
#define HDR_BYTES(dsk,t,s)   HDR_U16(dsk,t,s,9)
// reserved
#define HDR_RSVD(dsk,t,s) HDR_U16(dsk,t,s,11)
// the block is the first in the file
#define HDR_IS_FIRST(dsk,t,s) ((HDR_PREV_SEC(dsk,t,s) == 0xFF) && \
			       (HDR_PREV_TRK(dsk,t,s) == 0xFF))
// the block is the last in the file
#define HDR_IS_LAST(dsk,t,s) ((HDR_U8(dsk,t,s,3) & 0x80) == 0x80)
// the number of bytes used in the block
#define HDR_BYTES_USED(dsk,t,s) (HDR_U16(dsk,t,s,2) & 0x7FFF)

// return 1 if the filename pointed at is legal for ptdos
static int
legal_ptdos_filename(char *fname)
{
    int i;

    int len = strlen(fname);
    if (len < 1 || len > 8)
	return 0;

    for(i=0; i<len; i++) {
	char c = fname[i];
	if ( (c < 0x20) ||
	     (c == ' ') ||
	     (c == '#') ||
	     (c == ',') ||
	     (c == '/') ||
	     (c == ';') ||
	     (c == '<') ||
	     (c == '=') ||
	     (c == '>') ||
	     (c == 0x7F) )
	    return 0;
    }
    return 1;
}


// convert ptdos to dos filename (remap illegal filename chars)
static char *
dos_filename(char *fname, int action)
{
    static char newname[16];
    int i, len;

    if (!legal_ptdos_filename(fname))
	return NULL;	// not valid PTDOS name

    len = strlen(fname);
    for(i=0; i<len; i++) {
	char c = (fname[i] & 0x7F);
	switch (c) {
	    case ':': newname[i] = '#'; break;
	    case '?': newname[i] = '='; break;
	     default: newname[i] = c;   break;
	}
    }
    newname[i++] = '.';
    newname[i++] = (action & DISK_XHEX) ? 'h' : 'b';
    newname[i++] = (action & DISK_XHEX) ? 'e' : 'i';
    newname[i++] = (action & DISK_XHEX) ? 'x' : 'n';
    newname[i++] = '\0';
    return newname;
}


// ========================================================================
// routines to aid emitting a binary file in intel HEX format
//    void stream_start(char *filename, int format, FILE *msg)
//    void stream_emit(int addr, unsigned char byte)
//    void stream_end(int start_addr)
//    void stream_abort(void)  // on error
// ========================================================================

#define BYTES_PER_LINE 16	// maximum number of data bytes on the line
static unsigned char hex_data[BYTES_PER_LINE];
static int hex_1st_addr;	// address of first byte on line
static int hex_cur_addr;	// address of next byte to emit
static int hex_bytes;		// number of bytes emitted on this line
static FILE *stream_fp;		// output file handle
static FILE *stream_msg;	// error file handle

enum { STREAM_BINARY,	// binary file output
       STREAM_HEX };	// intel HEX output
			// .ENT format?
static int stream_fmt;	// what format to save data

// called at the start of the file.
// returns 0 on success.
static int
stream_start(char *filename, int format, FILE *msg)
{
    stream_fmt = format;
    stream_msg = msg;

    stream_fp = fopen(filename, (format == STREAM_BINARY) ? "wb" : "w");
    if (stream_fp == NULL) {
	fprintf(stream_msg,
		"Error attempting to open output file '%s'\n", filename);
	return 1;	// failed to open
    }

    hex_bytes = 0;

    return 0;		// no errors
}


// flush the accumulated buffer
static void
hex_flush(void)
{
    const int addr_msb = (hex_1st_addr >> 8) & 0xff;
    const int addr_lsb = (hex_1st_addr >> 0) & 0xff;
    int hex_cksum = (hex_bytes + addr_msb + addr_lsb) & 0xff;
    int i;

    if (hex_bytes == 0)
	return;

    if (stream_fp != NULL)
	fprintf(stream_fp, ":%02X%04X00", hex_bytes, hex_1st_addr);

    for(i=0; i<hex_bytes; i++) {
	if (stream_fp != NULL)
	    fprintf(stream_fp, "%02X", hex_data[i]);
	hex_cksum = (hex_cksum + hex_data[i]) & 0xFF;
    }

    if (stream_fp != NULL)
	fprintf(stream_fp, "%02X\n", (0x100 - hex_cksum) & 0xff);	// cksum 2's complement

    // init in preparation of next line
    hex_bytes = 0;
}


// called repeatedly with the next byte of the file
static void
stream_emit(int addr, unsigned char byte)
{
    const int non_consecutive = ((hex_bytes > 0) && (addr != hex_cur_addr));

    switch (stream_fmt) {

	case STREAM_BINARY:
	    if (non_consecutive)
		fprintf(stream_msg,
			"WARNING: non-consecutive byte addresses in file\n");
	    if (stream_fp != NULL)
		fprintf(stream_fp, "%c", byte);	// dump as binary file
	    hex_cur_addr++;
	    break;

	case STREAM_HEX:
	    if (non_consecutive || 		// non-consecutive byte stream
		(hex_bytes == BYTES_PER_LINE))	// full row
		hex_flush();

	    if (hex_bytes == 0) {
		hex_1st_addr = addr;
		hex_cur_addr = addr + 1;
	    } else {
		hex_cur_addr++;
	    }

	    hex_data[hex_bytes++] = byte;
	    break;

	default:
	    assert(0);
    }
}


// called at end of the file along with a start address.
// if start_addr == -1, then don't emit start address.
static void
stream_end(int start_addr)
{
    switch (stream_fmt) {

	case STREAM_BINARY:
	    if (start_addr >= 0) {
		fprintf(stream_msg,
		"WARNING: no way to save start address 0x%04X on binary file\n",
		    start_addr);
	    }
	    break;

	case STREAM_HEX:
	    // flush any residual bytes
	    if (hex_bytes > 0)
		hex_flush();

	    // start address record (if requested)
	    if (start_addr >= 0) {
		const int start_addr_msb = (start_addr >> 8) & 0xff;
		const int start_addr_lsb = (start_addr >> 0) & 0xff;
		int cksum = (0x04 + 0x03 + start_addr_msb + start_addr_lsb) & 0xff;
		// record type 03
		if (stream_fp != NULL)
		    fprintf(stream_fp, ":04000003%04X%02X\n", start_addr, cksum);
	    }

	    // end of file record
	    if (stream_fp != NULL)
		fprintf(stream_fp, ":00000001FF\n");
	    break;

	default:
	    assert(0);
    }

    if (stream_fp != NULL) {
	fclose(stream_fp);
	stream_fp = NULL;
    }
}


// called when file processing should stop immediately
static void
stream_abort(void)
{
    if (stream_fp != NULL) {
	printf("Aborting stream\n");
	fclose(stream_fp);
	stream_fp = NULL;
    }
}


// ========================================================================
// this is a byte stream filter for PTDOS binary image files.
// these files hold executables or just some type of memory image.
// the file consists of a number of "segments"; each segment begins
// with a four byte header, followed by a variable number of data bytes.
// the header starts with two bytes indicating how many data bytes are
// in the segment, and two bytes indicating at which address to load
// the data.  this way non-contiguous memory images can be loaded.
// there is a twist, however.  If the very last segment consists of
// a zero length data segment, then the address field supplies the
// execution address of the program; alternatively, if the file ends
// with two bytes after the last complete block, then this supplies
// the executable address.
// ========================================================================

enum { FILTER_NONE,	// no interpretation
       FILTER_IMAGE };  // PTDOS image format
static int filter_type;

static int filter_check;	// report errors found
static FILE *filter_msg;	// cached error message handle

enum { SEGST_0,		// between segments
       SEGST_1,		// between 1st and 2nd header bytes
       SEGST_2, 	// between 2nd and 3rd header bytes
       SEGST_3,		// between 3rd and 4th header bytes
       SEGST_4 };	// in the data portion of the segment
static int seg_state;	// where we are interpreting the byte stream
static int seg_len;	// number of bytes left in image segment
static int seg_addr;	// address of byte getting dumped

static void
filter_start(int action, char *filename, FILE *msg)
{
    filter_check = !!(action & DISK_FILECHECK);
    filter_type  =   (action & DISK_XIMAGE) ? FILTER_IMAGE : FILTER_NONE;
    stream_fmt   =   (action & DISK_XHEX)   ? STREAM_HEX   : STREAM_BINARY;
    filter_msg   = msg;

    (void)stream_start(filename, stream_fmt, msg);

    switch (filter_type) {

	case FILTER_NONE:
	    seg_addr = 0x0000;	// FIXME: something better?
	    break;

	case FILTER_IMAGE:
	    seg_state = SEGST_0;
	    break;

	default:
	    assert(0);
    }
}

static void
filter_byte(int byte)
{
    switch (filter_type) {

	case FILTER_NONE:
	    stream_emit(seg_addr,byte);
	    seg_addr++;
	    break;

	case FILTER_IMAGE:
	    switch (seg_state) {
	    // FIXME: little endian or big?  confirm.
		case SEGST_0:
		    seg_len   = byte;
		    seg_state = SEGST_1;
		    break;
		case SEGST_1:
		    seg_len  |= (byte << 8);
		    seg_state = SEGST_2;
		    break;
		case SEGST_2:
		    seg_addr  = byte;
		    seg_state = SEGST_3;
		    break;
		case SEGST_3:
		    seg_addr |= (byte << 8);
		    seg_state = (seg_len > 0) ? SEGST_4 : SEGST_0;
#if 1
		    printf("segment: len=%d, addr=%04X\n", seg_len, seg_addr);
#endif
		    break;
		default:
		    // processing bytes
		    stream_emit(seg_addr,byte);
		    seg_addr++;
		    seg_len--;
		    if (seg_len == 0)
			seg_state = SEGST_0;
		    break;
	    } // switch
	    break;

	default:
	    assert(0);
    }
}


static void
filter_end()
{
    switch (filter_type) {

	case FILTER_NONE:
	    stream_end(-1);
	    break;

	case FILTER_IMAGE:
	    // image files can indicate the start address
	    switch (seg_state) {
		case SEGST_0:  // no start address supplied
		    stream_end(-1);
		    break;
		case SEGST_2:
		    // two trailing bytes supplies start address
		    stream_end(seg_addr);
		    break;
		default:
		    if (filter_check)
			fprintf(filter_msg, "WARNING: image file ended in unexpected state\n");
		    stream_end(-1);
		    break;
	    }
	    break;

	default:
	    assert(0);
    }
}


// called when file processing should stop immediately
static void
filter_abort()
{
    stream_abort();
}


// ========================================================================
// walk through the disk data structure and pull out the files while
// checking for file integrity.
// ========================================================================

// follow the chain of blocks in the file starting at the given block.
// "err" returns 0 if there were no serious errors, and non-zero otherwise.
// "warns" returns the count of warnings encountered decoding the file.
// "length" returns the number of bytes in the file, which should be
//     considered unreliable if the return status indicates an error.
// "blocks" is the number of blocks used by the file
//
// "name" is the name of the file being inspected.
// first_sec, file_blks, and file_id are attributes from the dir entry.
// "action" contains flags indicating what needs to be done.
// "dos_name" is the name of the file to extract to, if required and
//     is NULL otherwise.

#define WARN_THOLD 20
#define DECODE_WARNING { (*warns)++; if (*warns > WARN_THOLD) DECODE_ERR }
#define DECODE_ERR     { filter_abort(); *err = 1; return; }

static void
disk_decode_file(svh_disk_t *disk, FILE *msg,
		 int action, char *name, char *dos_name,
		 int first_trk, int first_sec,
		 int file_blkz, int file_blks, int file_id,
		 int *err, int *warns, int *bytes, int *blocks)
{
    const int extract     = !!(action & DISK_EXTRACT);
    const int report_errs = !!(action & DISK_FILECHECK);
    const int directory = (first_trk == 25) && (strcmp(name, "DIRECTRY") == 0);
    int hit_end = 0;	// hit end of file marker
    int t, s;		// current track and sector
    int tp, sp;		// previous track and sector
    int b, total_bytes;

    *bytes = *blocks = 0;
    *warns = 0;
    *err   = 0;

    if ((file_blks < 0) || (file_blks >= SECTORS*TRACKS)) {
	if (report_errs)
	    fprintf(msg, "ERROR: filename '%s' claims it uses %d blocks\n", name, file_blks);
	*err = 1;
	return;
    }

    t = first_trk;
    s = first_sec;
    total_bytes = 0;

    // printf("name=%s, dos_name=%s\n", name, dos_name);
    if (extract && ((dos_name != NULL) && (strlen(dos_name) != 0)))
	filter_start(action, dos_name, msg);

    // see if the name is a legal PTDOS name
    if (!legal_ptdos_filename(name)) {
	if (report_errs)
	    fprintf(msg, "WARNING: filename '%s' isn't legal for PTDOS\n", name);
	DECODE_WARNING;
    }

    // visit each data block in the chain until the end
    for(b=1; ; b++) {

	int data_b, last_blk1, last_blk2;

	if (t >= TRACKS) {
	    if (report_errs)
		fprintf(msg, "ERROR: file '%s', block %d of %d, is supposed to be on track %d (>%d)\n",
			name, b, file_blks, t, TRACKS-1);
	    DECODE_ERR;
	}

	if (s >= SECTORS) {
	    if (report_errs)
		fprintf(msg, "ERROR: file '%s', block %d of %d, is supposed to be sector %d (>%d)\n",
			name, b, file_blks, s, SECTORS-1);
	    DECODE_ERR;
	}

	(*blocks)++;	// one more block in chain

	if (HDR_CRCERR(disk,t,s)) {
	    if (report_errs)
		fprintf(msg, "ERROR: file '%s', block %d of %d, bad header CRC at track %d, sector %d\n",
			name, b, file_blks, t, s);
	    DECODE_ERR;
	}

	if (HDR_SIZE(disk,t,s) != 13) {
	    if (report_errs)
		fprintf(msg, "ERROR: file '%s', block %d of %d, bad header length %d at track %d, sector %d\n",
			name, b, file_blks, HDR_SIZE(disk,t,s), t, s);
	    DECODE_ERR;
	}

	if (HDR_BYTES(disk,t,s) != file_blkz) {
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', block %d of %d, track %d, sector %d:\n"
				"         block size should be 0x%04X but it is 0x%04X\n",
			name, b, file_blks, t, s,
			file_blkz, HDR_BYTES(disk,t,s) );
#if 1
	    DECODE_WARNING;
#else
	    DECODE_ERR;
#endif
	}

	// make sure file id is correct
	if (file_id != HDR_FILE_ID(disk,t,s)) {
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', block %d of %d, track %d, sector %d:\n"
			     "         file ID should be 0x%04X but claims 0x%04X\n",
			name, b, file_blks, t, s,
			file_id, HDR_FILE_ID(disk,t,s) );
#if 1
	    DECODE_WARNING;
#else
	    DECODE_ERR;
#endif
	}

	// make sure back pointer is correct
	if (b == 1) {
	    // first block should have back pointer of 0xFF,0xFF
	    if ((HDR_PREV_TRK(disk,t,s) != 0xFF) ||
	        (HDR_PREV_SEC(disk,t,s) != 0xFF)) {
		if (report_errs)
		    fprintf(msg, "WARNING: file '%s', block %d of %d: track %d, sector %d:\n"
				    "         first block of file claims previous block track/sector of (%d,%d)\n",
			    name, b, file_blks, t, s,
			    HDR_PREV_TRK(disk,t,s), HDR_PREV_SEC(disk,t,s) );
#if 1
		DECODE_WARNING;
#else
		DECODE_ERR;
#endif
	    }
	} else if ( !directory &&
			((tp != HDR_PREV_TRK(disk,t,s)) ||
			 (sp != HDR_PREV_SEC(disk,t,s))) ) {
	    // it appears that the links on the disk directory don't follow these rules
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', block %d of %d: track %d, sector %d:\n"
				"         previous track/sector was (%d,%d), but link claims (%d,%d)\n",
			name, b, file_blks, t, s,
			tp, sp, HDR_PREV_TRK(disk,t,s), HDR_PREV_SEC(disk,t,s) );
#if 1
	    DECODE_WARNING;
#else
	    DECODE_ERR;
#endif
	}

	last_blk1 = (b == file_blks);
	last_blk2 = HDR_IS_LAST(disk,t,s);

#if 0 // apparently this is legal since it happens so frequently
	if (!last_blk1 && last_blk2) {
	    if (report_errs) {
		fprintf(msg, "WARNING: file '%s', block %d was last; %d blocks expected\n",
			name, b, file_blks);
		fprintf(msg, "         next t/s = %d/%d\n",
			HDR_NXT_SEC(disk,tp,sp), HDR_NXT_TRK(disk,tp,sp));
	    }
	    DECODE_WARNING;
	}
#else
	// if the block has the last-block bit set, we keep traversing
	// all blocks in the chain, but we don't extract any more bytes.
	if (!last_blk1 && last_blk2)
	    hit_end = 1;
#endif

	if (last_blk1 && !last_blk2) {
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', %d blocks claimed by dir, but more in chain\n",
			name, b, file_blks);
	    DECODE_WARNING;
	}

	if (last_blk2)
	    data_b = HDR_BYTES_USED(disk,t,s);	// use used byte length, not block size
	else
	    data_b = DATA_SIZE(disk,t,s);	// use how much is actually recorded

	if (data_b == 0) {
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', block %d of %d, bad data length %d, track %d, sector %d\n",
			name, b, file_blks, data_b, t, s);
	    DECODE_WARNING;
	}

	if (data_b > file_blkz) {
	    if (report_errs)
		fprintf(msg, "WARNING: file '%s', block %d of %d, data block has more bytes\n"
			     "         (%d) than block size (%d) at track %d, sector %d\n",
			name, b, file_blks, data_b, file_blkz, t, s);
	    DECODE_WARNING;
	}

	// FIXME: make sure we don't point past end of buffer

	if (DATA_CRCERR(disk,t,s)) {
	    if (report_errs)
		fprintf(msg, "ERROR: file '%s', block %d of %d, bad data CRC at track %d, sector %d\n",
			name, b, file_blks, t, s);
#if 0	// FIXME: error, or just warn that extracted data is possibly bad?
	    DECODE_WARNING;
#else
	    DECODE_ERR;
#endif
	}

	// if we are to extract the file, dump the bytes
	if (!hit_end) {
	    uint8 *data = DATA_PTR(disk,t,s);
	    if (extract) {
		int i;
		for(i=0; i<data_b; i++) {
		    filter_byte(data[i]);
		    total_bytes++;
		}
	    } else
		total_bytes += data_b;
	} // if (!hit_end)

#if 0
	// be conservative -- stop at short of what dir expects and actual chain length
	if (last_blk1 || last_blk2)
	    break;
#else
	// just follow the file chain unless there are errors
	if (last_blk2 || (last_blk1 && (*err > 0)))
	    break;	// be conservative
#endif

	// go to next block
	tp = t; sp = s;
	s = HDR_NXT_SEC(disk,tp,sp);
	t = HDR_NXT_TRK(disk,tp,sp);

    } // for(b)

    if (extract)
	filter_end();

    *err   = 0;	// if we got here, no serious erros
    *bytes = total_bytes;
}


// return 1 if name fits the pattern defined by spec
//     '?' matches any character
//     '*' matches any sequence of characters
//     characters match literally,
static int
wildcard(char *name, char *spec)
{
#if 0
    // just exact match
    return !strcmp(name, spec);
#else
    int case_sensitive = FALSE;
    return IsWildcardMatch(spec, name, case_sensitive);
#endif
}


// return pointer to a string that decodes the specified file type byte
char *
filetype_symbol(int file_type)
{
    static char buff[4];
    char *p;

    switch (file_type) {
// according to p 5-2 of the PTDOS manual, file_type has this definition:
//	case 0xFF: p = "table didn't say"; break; // Device files (drivers)
//	case 0x80-FE: executable (that is, msb=1 means executable)
	case 0x00: p = "I00"; break; // System Image File
	case 0x43: p = "IC";  break; // System Command Program
	case 0x47: p = "IG";  break; // Game Program
	case 0x53: p = "IS";  break; // System Program (e.g., ASSM)
//	case 0x54: p = "I$";  break; // System $Command File
	case 0x2A: p = "I.";  break; // Default Image File
	case 0x80: p = "00";  break; // System Data File
	case 0x81: p = "01";  break; // Focal Binary Data File
	case 0x82: p = "02";  break; // BCD Data File
	case 0x83: p = "03";  break; // Focal Program
	case 0x84: p = "04";  break; // BASIC/5 Program
	case 0x85: p = "05";  break; // BASIC Program, Semi-Compiled Form
	case 0x86: p = "06";  break; // BASIC Program, Text Form
	case 0x87: p = "07";  break; // BASIC Serial Access Data File
	case 0x88: p = "08";  break; // BASIC Random Access Data File
	case 0xA4: p = "$";   break; // Command File
	case 0xAE: p = ".";   break; // Default Data File
	case 0xC1: p = "A";   break; // SAVE Archive File
// Utilities disk listing seems to add these as well:
	case 0x24: p = "I$";  break; // System $Command File
	case 0x4C: p = "IL";  break;
	case 0x55: p = "IU";  break;
	case 0x44: p = "D";   break;
	case 0x20: p = "I";   break;
	case 0xCC: p = "L";   break;
	case 0xD3: p = "S";   break;

// Other listings show these types as well:
/*
hmm, utiltieis disk indicates x24 is I$, not x54
   IW (eg 1610, )
   ID (eg CNTRNX.D, DECIS.D, DECWR.D
   IF (eg GL437
   IP (eg DBASIC
   C  (eg CONVERT, SORTCNTL
   M  (eg GL331.M
   P  (eg NEWDOC, DUPLDOC
   T  (eg GL331.M, CTAPE.A, HELP:D
   W  (eg, MENU, SPACE)
other codes in use:
2E (eg, DISKTEST, 16K8, 32K)
54 (eg, CTAP:S)
FF (driver)
56 (TEST)
57 (Sol2E)
58 (DUMP:I, ENTER, VIDEO, PURGE)
D4 (NPTDEFS)
*/
	  default: // not predefined
	    sprintf(buff, "x%02X", file_type);
	    p = buff;
	    break;
    }
    return p;
}


// convert string to uppercase in place
static void
uppercase(char *p)
{
    int len = strlen(p);
    int i;

    for(i=0; i<len; i++) {
	if (p[i] >= 'a' && p[i] <= 'z')
	    p[i] += 'A' - 'a';
    }
}

// list/check/extract specified files in alphabetical order
#define ENTRIES_PER_SECTOR (12)  // number of dir entries per 256B sector
void
ptdos_disk_decode(svh_disk_t *disk, int action, char *filespec)
{
    const int t = 25;	// in PTDOS, the directory occupies all of track 25

    struct {		// used to hold pointers to files of interest
	char name[9];
	int  sec;
	int  entry;
    } order[SECTORS*ENTRIES_PER_SECTOR];
    int valid_entries = 0;

    // pointers to important files
    int directry_sec = -1, directry_entry = -1;
    int fsmap_sec    = -1, fsmap_entry    = -1;
    int nextid_sec   = -1, nextid_entry   = -1;

    int verbosity = 0;
    int files_decoded = 0;
    int qdir    = !!(action & DISK_QUICKDIR);
    int dir     = !!(action & DISK_DIRECTORY);
    int extract = !!(action & DISK_EXTRACT);
    int binary  = !!(action & DISK_XIMAGE);
    int check   = !!(action & DISK_FILECHECK);

    char *fsmap = NULL;	// pointer to fsmap file (freespace map)

    int i, j, e, s;

    // errors about file integrity are sent to stderr unless that is
    // the only thing we are doing, in which case it goes to stdout
    FILE *msg = (check && !extract) ? stdout : stderr;

    assert(disk != NULL);

#define U8(d,offset)  ((int)((d)[(offset)]))
#define U16(d,offset) (U8((d),(offset)) + (U8((d),(offset)+1)<<8))

    // ----------------------------------------------------
    // first, build up the list of filenames

    for(s=0; s<SECTORS; s++) {
	int hdr_len = HDR_SIZE(disk,t,s);
	int bytes   = DATA_SIZE(disk,t,s);
	int nxt_entry;		// pointer to next free entry in block
	int num_entries;	// # entries in block

	if (hdr_len == 0) {
	    if (verbosity > 0)
		printf("Directory track, sector %d has no header\n", s);
	    continue;	// next sector
	}
	if (bytes != 256) {
	    if (verbosity > 1);
		printf("Directory track, sector %d has block length of %d\n", s, bytes);
	    continue;	// next sector
	}

	num_entries = DIR_NUM_ENTRIES(disk,t,s);
	nxt_entry   = DIR_NEXT_FREE_BYTE(disk,t,s);

	if (verbosity > 1) {
	    printf("Directory track %d, sector %d\n", t, s);
	    printf("Number of entries: %d\n", num_entries);
	    printf("Next free entry of block: %d\n", nxt_entry);
	}

	if (num_entries > ENTRIES_PER_SECTOR) {
	    fprintf(msg, "WARNING: directory track, sector %d claims to have %d entries (%d max)\n",
		    s, num_entries, ENTRIES_PER_SECTOR);
	    num_entries = ENTRIES_PER_SECTOR;
	}

	for(e=0; e<num_entries; e++) {

	    char *filename = DIR_FILE_NAME(disk,t,s,e); // PTDOS filename

	    uppercase(filename);	// ignore case for sort

	    // make sure critical files appear on disk
	    if (strcmp(filename, "DIRECTRY") == 0)
		{ directry_sec = s; directry_entry = e; }
	    if (strcmp(filename, "FSMAP") == 0)
		{ fsmap_sec = s; fsmap_entry = e; }
	    if (strcmp(filename, "NEXTID") == 0)
		{ nextid_sec = s; nextid_entry = e; }

	    if ((filespec != NULL) && !wildcard(filename, filespec))
		continue;	// didn't match

	    strcpy(order[valid_entries].name, filename);
	    order[valid_entries].sec = s;
	    order[valid_entries].entry = e;
	    valid_entries++;

	}  // for(e<num_entries)

    } // for(s<sectors)

    // ----------------------------------------------------
    // sort the entries alphabetically -- overkill, but PTDOS does this.
    // filename case is preserved, but it is ignored during sort.
    // simple insertion sort
#if 1
    for(i=0; i<valid_entries-1; i++) {

	int best_j = i;
	int best_sec, best_entry;
	char best_name[9];
	for(j=i+1; j<valid_entries; j++) {
	    if (strcmp(order[j].name, order[best_j].name) < 0)
		best_j = j;
	}

	// swap best with lowest
	strcpy(best_name, order[best_j].name);
	best_sec   = order[best_j].sec;
	best_entry = order[best_j].entry;

	strcpy(order[best_j].name, order[i].name);
	order[best_j].sec   = order[i].sec;
	order[best_j].entry = order[i].entry;

	strcpy(order[i].name, best_name);
	order[i].sec   = best_sec;
	order[i].entry = best_entry;
    }
#endif

    // ----------------------------------------------------
    // more sanity checking
    if (check) {

	// check that no filename appears twice
	for(i=0; i<valid_entries-1; i++) {
	    if (strcmp(order[i].name, order[i+1].name) == 0)
		fprintf(msg, "WARNING: filename '%s' appears on disk twice\n", order[i].name);
	}

	// make sure critical files appear on disk
	if (directry_sec < 0) {
	    fprintf(msg, "WARNING: disk doesn't contain critical file 'DIRECTRY'\n");
	} else {
	    int s = directry_sec;
	    int e = directry_entry;
	    int file_trk = DIR_FILE_TRK(disk,t,s,e);	// file block track
	    if (file_trk != t) {
		// this would be a strange error, but might as well check it
		fprintf(msg, "WARNING: directory claims DIRECTRY is on track %d (should be %d)\n", 
			    file_trk, t);
	    }
	}

	if (fsmap_sec >= 0) {
	    int s = fsmap_sec;
	    int e = fsmap_entry;
	    int file_sec = DIR_FILE_SEC(disk,t,s,e);	// file block sector
	    int file_trk = DIR_FILE_TRK(disk,t,s,e);	// file block track
	    fsmap = DATA_PTR(disk, file_trk, file_sec);
	    if ((fsmap != NULL) &&
		(DATA_SIZE(disk, file_trk, file_sec) < (SECTORS*TRACKS+7)/8))
		    fsmap = NULL;
	}

	// save pointer to actual free space map
	if (fsmap == NULL)
	    fprintf(msg, "WARNING: disk doesn't contain valid critical file 'FSMAP'\n");
	// FIXME: there are two ways we could use this information:
	//        1) check that every sector reserved for a file is not
	//           on the free list
	//        2) build up a free list by OR'ing all the sectors in use
	//           and after processing the whole file, check that the
	//           generated one matches this fsmap.  It only makes sense
	//           if we aren't wildcarding on a subset of the files, and
	//           we must also mark off any index files.

	if (nextid_sec < 0) {
	    fprintf(msg, "WARNING: disk doesn't contain critical file 'NEXTID'\n");
	} else {
	    // FIXME: I guess I could read it out and make sure no file
	    // is using a value greater than this
	}

    } // if (check)

    // ----------------------------------------------------
    // process the files in sorted order

    if (dir || qdir)
	label_emit(stdout, disk->label);

    // decode the directory
    for(i=0; i<valid_entries; i++) {

	int s = order[i].sec;
	int e = order[i].entry;

	int file_type = DIR_FILE_TYPE(disk,t,s,e);	// file type
	int file_blkz = DIR_BLOCK_SIZE(disk,t,s,e);	// file size in bytes
	int file_prot = DIR_FILE_PROT(disk,t,s,e);	// file protection attributes
	int file_id   = DIR_FILE_ID(disk,t,s,e);	// file protection attributes
	int fidx_sec  = DIR_IDX_SEC(disk,t,s,e);	// index block sector
	int fidx_trk  = DIR_IDX_TRK(disk,t,s,e);	// index block track
	int file_sec  = DIR_FILE_SEC(disk,t,s,e);	// file block sector
	int file_trk  = DIR_FILE_TRK(disk,t,s,e);	// file block track
	int file_blks = DIR_FILE_BLKS(disk,t,s,e);	// number of blocks in file
	char file_ctype = ((file_type & 0x7F)<0x20) ? 0x20 : (file_type & 0x7F);
	char *name = DIR_FILE_NAME(disk,t,s,e);		// PTDOS filename

	char protstr[9];		// file protections
	char *dos_name;			// filename mapped to a legal DOS name
	int errs, warns, len, blocks;

	bzero(protstr, sizeof(protstr));
	if (file_prot != 0x00) {
	    static char flags[] = "KWRIANEU";
	    // kill, write, read, info, attrib, name & type, extent (file size)
	    for(j=0; j<8; j++)
		if ((file_prot >> j) & 1)
		    protstr[strlen(protstr)] = flags[j];
	}

	if (verbosity > 2) {
	    // print raw dir entry as ascii hex
	    printf("# ");
	    for(j=0; j<21; j++)
		printf("%02X ", DIR_U8(disk,t,s,e,j));
	    printf("\n");
	}

	if (verbosity > 0) {
	    printf("# Filename:'%s', type '%c' (0x%02X), 0%04X blksiz, prot=0x%02X\n",
		    name, file_ctype, file_type, file_blkz, file_prot);
	    if (file_prot != 0x00)
		printf("#     prot: %-8s\n", protstr);
	    printf("#       id: 0x%04x (%d)\n", file_id, file_id);
	    if (DIR_HAS_INDEX(disk,t,s,e))
		printf("#       idx: sec=%d, trk=%d\n", fidx_sec, fidx_trk);
	    printf("#     data: sec=%d, trk=%d\n", file_sec, file_trk);
	    printf("#   blocks: 0x%04x (%d)\n", file_blks, file_blks);
	    printf("#    directory sector %d, slot %d\n", s, e);
	}

	if (++files_decoded % FILES_PER_DIR_HEADER == 1) {
	    if (qdir) {
		printf("\n  NAME      TYPE  SIZE   BLKZ    ID    SEC  TRK  ATTRI    INDEX\n");
		printf(  "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+\n");
	    }
	    if (dir) {
		printf("\n  NAME      TYPE  SIZE  BLKZ   BYTES   ID   SEC  TRK  ATTRI    INDEX\n");
		printf(  "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-\n");
	    }
	}

	dos_name = (extract) ? dos_filename(name, action) : NULL;

	if (dir || extract || check) {
	    disk_decode_file(disk, msg,
			     action, name, dos_name,
			     file_trk, file_sec,
			     file_blkz, file_blks, file_id,
			     &errs, &warns, &len, &blocks);
	}

	if (qdir) {
	    printf(" %s", name);
	    for(j=strlen(name); j<10; j++)
		printf(" ");
	    printf("  %-3s  %3d    %04X   %04X    %2d   %2d  %-8s",
		    filetype_symbol(file_type),
		    file_blks,
		    file_blkz, file_id,
		    file_sec, file_trk,
		    protstr);
	    if (fidx_sec == 0x00 && fidx_trk == 0x00)
		printf("\n");
	    else
		printf(" %02X%02X\n", fidx_trk, fidx_sec);
	}

	if (dir) {
	    printf(" %s", name);
	    for(j=strlen(name); j<10; j++)
		printf(" ");
	    printf("  %-3s  %3d   %04X  %6d  %04X   %2d   %2d  %-8s",
		    filetype_symbol(file_type),
		    file_blks,
		    file_blkz,
		    len,
		    file_id,
		    file_sec, file_trk,
		    protstr);
	    if (fidx_sec != 0x00 || fidx_trk != 0x00)
		printf(" %02X%02X", fidx_trk, fidx_sec);
	    else
		printf("     ");
	    printf("%s\n", (errs)  ? "  (errors)" :
			   (warns) ? "  (warnings)" :
				     "");
	}

	if (extract) {
	    printf("'%s' extracted to '%s', %d bytes\n",
		    name, dos_name, len);
	    // don't need to print summary of errors and warnings,
	    // because disk_decode_file() is verbose when actually
	    // extracting a file
	}

    } // for(i<valid_entries)
}


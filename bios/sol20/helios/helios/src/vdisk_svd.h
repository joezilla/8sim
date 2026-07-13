// Author: Jim Battle, 2004
// Borrowed from:
//    Solace -- Sol Anachronistic Computer Emulation
//    A Win32 emulator for the Sol-20 computer.
//    Copyright (c) Jim Battle, 2004
//
// This file contains structures and function prototypes for
// manipulating virtual northstar disks for Solace, the Sol emulator.

// Common virtual disk access functions.

#ifndef _VDISK_SVD_H_
#define _VDISK_SVD_H_

#include "types.h"

// some disk properties
#define SVD_HDR_SIZE      (4096)	// # bytes in svd header
#define SVD_LABEL_SIZE    (3*1024)	// # bytes in svd label
#define SVD_FILENAME_SIZE (300)		// maximum fully specified filename size

// particular to SVN
#define SVD_MINTRACKS        (10)	// min number of tracks per side
#define SVD_MAXTRACKS        (96)	// max number of tracks per side
#define NS_SECTORS_PER_TRACK (10)	// number of sectors per track

// particular to SVH
#define SVH_SECTORS_PER_TRACK (16)	// number of tracks per side
#define SVH_TRACKS_PER_DISK   (77)	// number of sectors per track

#define SVD_FORMAT_SVN   (0)
#define SVD_FORMAT_SVH   (1)

// VIRTUAL DISK HEADER FORMAT:
//
// Each disk consists of a header and a fixed number of blocks.
// The header occupies the first 4 KB of the file, with any unused
// remainder of the 4 KB padded with 0x00 bytes.
//
// This header block has this fixed sequence:
//
//   struct {
//     char format[64];     "SVD:Solace Virtual Disk, blah blah\00\00..."
//     uint16 version;      [=1]
//     uint16 density;      [=1|2]
//     uint16 writeprotect; [=0|1]
//     uint16 sides;        [=1|2]
//     uint16 tracks;       [>=35, <1000]
//     uint16 sectors;
//     unsigned char pad[1024 - 64 - 6*2];
//     char label[3*1024];
//   }
//
// The format string is a null-terminated string that identifies
// what the rest of the header block might contain.  Any unused
// portion of the string should be set to 0x00.
//
// All the uint16 fields are stored little-endian, meaning that the
// least-significant byte of the 16b quantity is stored earlier in
// the file than the most-significant byte.
//
// Density indicates if the entire disk is single or double density.
// This field is used to minimize the file size if all sectors are
// known to be single-density.  It is OK to write nothing but single-
// density sectors to a double-density disk, or any mix, of course.
// Helios supports only single density.
//
// If writeprotect is 1, the disk shouldn't be written to; if it is 0,
// it is OK for the driver to write data to the disk.
//
// Sides indicates the number of sides that are writable on the disk.
// Single sided virtual disks take up less space on the real disk.
// Helios supports only single sided.
//
// Tracks is the number of tracks per side; it is 35 for the Northstar
// controller, but room has been left in the header for generality.
// Helios supports only 77 tracks.
//
// Sectors is the number of sectors per track; it is fixed at 10 for
// the Northstar controller, but room has been left in the header
// for generality.  Helios supports only 16 sectors/track.
//
// Pad should be filled with 0x00 bytes to round out the first 1KB
// of the header block.
//
// The label lines are a single null-terminated string, although
// there can be any number of lines, which are CR/LF terminated.
//
// The rest of the file is accessed randomly as fixed size blocks.
// These blocks are saved as a raw binary format.
//
// The number of blocks is (# sides)*(# tracks/side)*(# sectors/track).
//
// The size of each block depends on the density and the main format.
// Nominally there are 256 bytes/sector in single density, and 512
// bytes/sector in double density.  However, the actual number
// (unformatted) is dependent only on the rotational speed and the bit
// transfer rate.  At the nominal 300 RPM, each rotation takes 200 ms.
// At a transfer rate of 250 Kbps, this works out to 6250 bytes/track
// double density, and 3125 bytes/track single density.  In real life
// not all these bytes can be used, as the disk speed might be higher
// or lower, and each sector requires preamble and sync bytes.
//      single density (density==1): 256 +  56 = 312 bytes/block
//      double density (density==2): 512 + 112 = 624 bytes/block
//
// Although the standard Northstar format only uses a few of the "extra"
// bytes, for preamble and checksum, in theory they can be used and
// Solace should work for any such scheme too.
//
// The SVH format is very similar, but unfortunately not exactly the
// same because the Helios disk structure came to light shortly after
// SVN was set in stone.  For SVH, only single density is supported
// and there are 4 bytes of overhead and 324 bytes of payload per sector.
// The disk spins at 360 RPM, so each rotation takes 167 ms.
//
// The file that contains the virtual disk image adds yet another
// four bytes of overhead per sector, to save some per-sector meta-data.
// For SVN, only one bit of this is currently used, which is for indicating
// if the sector is recorded in single or double density.  SVH uses three
// of the bytes.
//
// Having a block size that isn't a power of two doesn't match very
// nicely to the actual disk blocking factor, but it is still tons
// faster than the floppy it is emulating, so no harm done.

// "magic" strings that appear tha the head of the virtual disk image,
// and are used to identify the major format of the disk.
// FIXME: change to SVD_MAGIC_STR to SVN_MAGIC_STR
#define SVN_MAGIC_STR     "SVD:Solace Virtual Disk, Northstar"
#define SVH_MAGIC_STR     "SVD:Solace Virtual Disk, Helios"

// return status used by various routines
#define SVD_OK           0	// everything is OK
#define SVD_FILEEXISTS  -1	// file already exists on disk
#define SVD_NOFILE      -2	// requested file doesn't exist
#define SVD_BADFILE     -3	// bad file format
#define SVD_OPENERROR   -4	// couldn't open file
#define SVD_ACCESSERROR -5	// couldn't read or write to file
#define SVD_BADFORMAT   -6	// the format of this disk is wrong
#define SVD_BADCRC      -7	// CRC error

// ===================================================================
//                       virtual disk structure
// ===================================================================

// information the program keeps about a virtual disk:
typedef struct {

    char filename[SVD_FILENAME_SIZE];	// path to file on disk

    int  format;	// one of SVD_FORMAT_{SVN,SVH}

    int  writeprot;	// 1=read only disk
    int  density;	// single or double density
    int  sides;		// sides per disk
    int  tracks;	// tracks per side
    int  sectors;	// sectors per track
    char label[SVD_LABEL_SIZE];	// diskette label

} svd_t;


// information that appears in the first 4K of the file
typedef struct {

    char format[64];	// "magic" file format string
    uint16 version;	// subtype of format
    uint16 writeprot;	// 1=read only disk
    uint16 density;	// single or double density
    uint16 sides;	// sides per disk
    uint16 tracks;	// tracks per side
    uint16 sectors;	// sectors per track
    uint8  pad[1024 - 64 - 6*sizeof(uint16)];
    char label[SVD_LABEL_SIZE];	// diskette label (at offset 1024)

} svd_header_t;


// return a descriptive string to decipher numeric error code
char* vdisk_errstring(int err);

// given a filename, read the header into an svd struct
int svd_read_file_header(const char *filename, svd_t *svd);

// modify the header block on the virtual disk without otherwise
// affecting the rest of the virtual disk.
int svd_write_file_header(svd_t *svd);

#if 0
// given a filename, get information about a disk.
// returns SVD_OK if it worked, something else if it didn't.
int
svd_read_disk_info( char *filename,		// in
		    int  *filetype,		// the rest are out...
		    int  *sides,
		    int  *tracks,
		    int  *sectors,
		    int  *density,
		    int  *writeprotect,
		    char *label,
		    int  *maxsectorsize);


// write a disk header to the specified file.
// returns SVD_OK if it worked, something else if it didn't.
// should this be changed so that only the writeprotect
// and the label can be modified?
int
svd_write_disk_info( char *filename,
		     int   sides,
		     int   tracks,
		     int   sectors,
		     int   density,
		     int   writeprotect,
		     char *label);
#endif

#endif // _VDISK_SVD_H_

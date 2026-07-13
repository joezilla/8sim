// Author: Jim Battle, 2004
// Borrowed from:
//    Solace -- Sol Anachronistic Computer Emulation
//    A Win32 emulator for the Sol-20 computer.
//    Copyright (c) Jim Battle, 2004
//
// This file contains structures and function prototypes for
// utility routines for manipulating SVH virtual disk images.

#ifndef _VDISK_SVH_LIB_H_
#define _VDISK_SVH_LIB_H_

#include "vdisk_svd.h"

/* -------------------------------------------------------------------

    HELIOS DISK SYSTEM DATA FORMAT

    The format used by the Helios system is quite odd.

    The disks are 32 sectored, hard sectored disks.  Every other sector
    boundary is ignored, so effectively there are 16 sectors per track.
    Since the disk is recorded in single density (250 Kbps), there are
    256 data bytes per sector.  However the disks, like all such disks,
    have extra bytes available per sector.  In fact, there are about
    325 bytes per sector at nominal rotational speed.  Due to variations
    in speed, not all bytes can be used since they can't be counted on.

    In most disk systems, some of these extra bytes are used for preambles,
    sync bytes, and perhaps a few extra bytes for sector/track addressing
    and checksum information.  Additionally, a number of bytes after the
    end of the block of data and before the start of the next sector can't
    be used reliably due to rotational speed variations (referred to as the
    intersector gap).

    The Helios system is no different in this regard.  Each block of data
    recorded in the Helios system has this format:

          15 bytes of 0x00 preamble   \__ 16 bytes
           1 byte  of sync byte       /
          13 bytes of header data     \
           2 bytes of CCITT-CRC16      >-- 16 bytes
           1 byte  of sync byte       /
          15 bytes of 0x00 preamble   \__ 16 bytes
           1 byte  of sync byte       /
         NNN bytes of data
           2 bytes of CCITT-CRC16
           1 byte  of sync byte
         ... bytes of 0x00 postamble

    The really strange thing about the Helios system is that data is
    recorded in variable sized blocks instead of fixed size 256 byte
    blocks.  Data blocks can be 1 byte to 4095 bytes long; the block
    of data spans one to thirteen sectors.  The reason the Helios did
    this was storage density.  Because there is only one preamble/
    header/checksum for a block instead of every 256 bytes, and more
    importantly, because the intersector gap can be used to record
    data.  This scheme allows about an extra 25% to be stored.
    Because of variations in rotational speed both in time and between
    different drives, only 320 bytes are counted upon by PTDOS.
    As a formula, the maximum block size is (256 + (N-1)*(256+64)).
    As a table, see below.

       Sectors  Max Block Size
       =======  ==============
          1       256  (0x100)
          2       576  (0x240)
          3       896  (0x380)
          4      1216  (0x4C0)
          5      1536  (0x600)
          6      1856  (0x740)
          7      2176  (0x880)
          8      2496  (0x9C0)
          9      2816  (0xB00)
         10      3136  (0xC40)
         11      3456  (0xD80)
         12      3776  (0xEC0)
         13      4095  (0xFFF)

    There are a few restrictions.  First, a block can't be longer than 13
    sectors.  Second, a block must all reside on one track.  Third, a block
    can not span the sector 15/sector 0 boundary.

    The down side is that managing file allocation is a lot more complex.
    Data blocks aren't necessarily powers of two, and there can be
    fragmentation of data on the disk.  Also, performing random accesses
    into a file is somewhat more complicated.  The total amount of data that
    can be stored to a disk is variable, depending how well blocked it is.

    HEADER FORMAT:

    Each block of data in the Helios system begins with a 13 byte header
    (plus two bytes CRC).  The format of this block is

        byte     0: this sector
        byte     1: this track
        byte     2: next sector
        byte     3: next track
        byte     4: prev sector
        byte     5: prev track
        bytes  7,6: file ID
        byte     8: block length, in sectors
        bytes 10,9: block length, in bytes
        byte    11: reserved
        byte    12: reserved

    The "this sector/track" fields indicate which sector the block of data
    begins on.  Although it is possible to use these fields to effect an
    interleave factor, in fact the Helios system simply numbers them
    sequentally from sector 0 to sector 15.

    The "next sector/track" fields are a pointer to the next block of data
    in the file, should another block be necessary.  If the current block
    is the last block in the file, then these two bytes should be saved as
    0xFF,0xFF.

    The "prev sector/track" fields are a pointer to the previous block
    of data in the file, should this block not be the first.  If the
    current block is the first block in the file, then these two bytes
    should be saved as 0xFF,0xFF.  So between the next and prev pointers,
    files are stored as a doubly linked list.

    The "file ID" field is a 16 bit serial number, unique to a given
    file.  All blocks that belong to a file have the same serial number.
    The operating system is responsible for handing out these serial
    numbers.  The serial number is specific to that disk.  It is possible
    for a single disk to have had >64K file creations/deletions, in
    which case it is necessary to copy the file onto another disk; the
    old disk could be formatted and reused, of course.

    The "block length in sectors" is pretty self-explanatory.

    The "block length in bytes" is a little more interesting.  Say a block
    of data uses 13 sectors, so it can hold up to 4095 bytes.  However,
    this field allows specifying that only the first NNNN bytes are
    meaningful.  This is most important in the final block in the file.
    Also, bit [15] of this field is actually a flag.  If bit [15] is 1,
    it means this is the last block of the file.

    Immediately following byte 12 is two more bytes containging a 16 bit
    CRC for the header.  The disk controller generates and checks these
    two bytes, so the driver software is not responsible for that bit of
    work.

    When the disk is initially formatted, every sector has a header
    consisiting of nothing but 0xFF bytes, and the data portion is a
    single 0xFF byte.

    EMULATED HELIOS DISK SYSTEM LIMITATIONS

    The Helios disk controller supplies a very high level interface, which
    is fortunate since the abstraction means its emulation can be similarly
    abstract.

	*) the preamble/postamble bytes aren't modelled.  these
           bytes can't be written or inspected by the host computer,
           so other than their effect on timing, they are invisible.

	*) the checksum bytes aren't modelled.  we are emulating a
           disk system where the disk surface is perfect and bit rot
           is unknown.  other than doing something silly like resetting
           the disk controller in the middle of a data write DMA
           operation there is no way for software to cause a bad CRC
           to be written, as the proper CRC is generated by the
           controller, not the host software.

        *) disk transfers occur via a high level DMA interface, so
           the exact timing of the disk system's behavior shouldn't
           influence the correctness of the emulation, so long as it
           is plausible.  Unlike the northstar disk emulation where
           I made it model a lot of low level timing details, my
           interest in the project is flagging a bit so I'm just going
           for functional correctness, not timing correctness.

    EMULATED HELIOS DISK SYSTEM FILE FORMAT

    Each disk consists of a header and a fixed number of blocks.  The
    header occupies the first 4 KB of the file and is stored as CR/LF-
    terminated ASCII strings, with any remainder of the 4 KB padded with
    0x00 bytes.

    This header block is described in vdisk_svd.h.

    This header block has this fixed sequence:

      struct {
	char format[64];     "SVD:Solace Virtual Disk, Helios\00\00..."
	uint16 version;      [=1]
	uint16 density;      [=1]
	uint16 writeprotect; [=0|1]
	uint16 sides;        [=1]
	uint16 tracks;       [=77]
	uint16 sectors;      [=16]
	unsigned char pad[1024 - 64 - 6*2];
	char label[3*1024];
      }

    Although this format does allow for specifying things like double
    sided disks and such, deviations from the original settings is likely
    to break this emulation.  It hasn't been written to respect all that
    parameterization.

    The format string is a null-terminated string that identifies what the
    rest of the header block might contain.  Any unused portion of the
    string should be set to 0x00.

    All the uint16 fields are stored little-endian, meaning that the least-
    significant byte of the 16b quantity is stored earlier in the file than
    the most-significant byte.

    Density is always single density.  The Helios system operated at
    250 Kbps (single density).

    If writeprotect is 1, the disk shouldn't be written to; if it is 0,
    it is OK for the driver to write data to the disk.

    Sides is always 1.  The persci disks used in the Helios were single-
    sided.

    Tracks is the number of tracks per side; it is always 77.

    Sectors is the number of sectors per track; it is always 16.

    Pad should be filled with 0x00 bytes to round out the first 1 KB of
    the header block.

    The label lines are a single null-terminated string, although
    there can be any number of lines, which are CR/LF terminated.

    The rest of the file is accessed randomly as fixed size blocks.
    These blocks are saved as a raw binary format.

    The number of blocks is (# sides)*(# tracks)*(16), which is 1*77*16,
    or 1232 blocks.

    Because the size of each block depends on the whims of the PTDOS file
    allocator, we need a scheme where we can tell which sectors start a
    block and which are part of the middle or end of block.  We would like
    to have a simple method of random access to a given sector or block of
    data.

    The solution employed here is to have four metadata bytes at the start
    of each sector immediately before the 320 bytes of real data in the
    sector.  Those four bytes at the start of each sector are used to
    convey information about how the sector is formatted.  This is required
    because the real disk format uses special "sync" bytes to indicate some
    meta information.  The sync byte is a specific bit sequence where one
    of the bit positions has an illegal clock transition.  The different
    pieces of information contained in the metadata bytes are

        1) the sector contains a valid header block

        2) the sector contains valid data bytes

        3) if the sector contains valid data bytes, is the sector the first
           (perhaps only) one of the data block

        4) if the sector contains valid data bytes, is the sector the last
           (perhaps only) one of the data block

        5) if the sector contains valid data bytes, how many are there?
           the valid range of counts is 1-320 bytes.  note: a block can
           be up to 4095 bytes long, but it will span multiple sectors.

    The Helios system used only single density recording.  As has been
    mentioned, each sector can hold 64+256 data bytes.  If a sector is the
    start of a block, the first 48 bytes contain the preamble and header
    information and the 256 data bytes + 2 CRC bytes + postamble occupy the
    remaining 272 bytes of the sector.  If a sector is a continuation of a
    block of data from the previous sector, all the bytes are used to hold
    the data; there is no header present.

   ------------------------------------------------------------------- */

// ===================================================================
//                       virtual disk structure
// ===================================================================

#define SVH_HDRSIZE           (13) // # of bytes in sector header

// ===================================================================
// per-sector metadata flags
// ===================================================================

// this is stored in the first byte of the per-sector overhead.
// it indicates what is going on in the sector.
#define SVH_FMT_HAS_HEADER  (0x01)  // bit indicating sector has header block
#define SVH_FMT_HAS_DATA    (0x02)  // bit indicating sector has data bytes
#define SVH_FMT_FIRST_DATA  (0x04)  // bit indicating sector is first of block
#define SVH_FMT_LAST_DATA   (0x08)  // bit indicating sector is last of block
#define SVH_FMT_CRCERR_HDR  (0x10)  // bit indicating sector has bad header CRC
#define SVH_FMT_CRCERR_DATA (0x20)  // bit indicating sector has bad data CRC

// ===================================================================
//
// ===================================================================

// create a blank virtual disk of the specified type
// return 0 if OK, otherwise some error indication.
// does not check if file already exists.
int svh_format(const char *filename, int writeprotect, char *label);

// write the header block of a sector; it must be 13 bytes, supplied in secbuf
int svh_write_sec_header(svd_t *svd, int track, int sector, int badcrc,
			 char *secbuf);

// read the header a block of data, if it exists
int svh_read_sec_header(svd_t *svd, int track, int sector,
			int *bytes, char *secbuf);

// write a block of data, 1-4095 bytes starting at the specified
// sector; the block may need to span multiple sectors.
int svh_write_blk_data(svd_t *svd, int track, int sector, int badcrc,
		       int data_bytes, char *secbuf);

// read a block of data; it may span multiple sectors and return up to
// 4095 bytes of data, which the caller must provide space for.
int svh_read_blk_data(svd_t *svd, int track, int sector,
		      int *bytes, char *secbuf);

#endif // ifdef _VDISK_SVH_LIB_H_

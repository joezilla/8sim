/*
 *    This module is responsible for reading the real helios/ptdos
 *    floppy disks via a PCI-attached Catweasel card.  With apologies
 *    to Tim Mann, I didn't carry forward the full generality of his
 *    code since I don't have a 1st generation Catweasel card to test
 *    things, nor am I set up to test things on a linux system.
 *
 *    This module is also responsible for FM decoding the bits on
 *    each track and storing the resulting byte and metadata into
 *    a decoded disk data structure.
 *
 *    This module can also write and read a virtual disk image in
 *    the "raw" format, which is simply the relevant parts of the
 *    the Catweasel sample buffer, track by track.  The reason for
 *    supporting this is that should a disk prove difficult to decode,
 *    it is easier/faster to twiddle the decoding heuristics from the
 *    virtual disk image instead of having to sample the physical disk
 *    for each run of the program.
 *
 *    The PCI scanning and catweasel interface routines are based on:
 *        cw2dmk: Dump floppy disk from Catweasel to .dmk format.
 *        Copyright (C) 2000 Timothy Mann
 *        Id: cw2dmk.c,v 1.28 2003/06/19 05:53:28 mann Exp $
 *        Modified by Jim Battle, 2004
 *
 *    Depends on Linux Catweasel driver code by Michael Krause
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

/*
     .raw files have this structure
     # blah blah blah             (comments)
     HELIOS raw                   (first line)
     LABEL first line of label    (optional)
     LABEL second line of label   (optional)
     TRACK t n                    (t=track number)
     INDEX s u o n                (s=sector, u=duration in us, o=offset, n=samples)
     hh hh hh hh ...              (n raw samples data in hex)
*/

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <signal.h>
#include <assert.h>
#include <math.h>	// for pow()

#include "helios.h"
#include "helios_raw.h"

#include "cwfloppy.h"
#include "cwpci.h"


// ========================================================================
// catweasel parameters
// ========================================================================

const int side = 0;	// doesn't matter for helios

// program operation
const int spinup_ms = 750;	// # of milliseconds to spin up to speed
const int rev_ms    = 167;	// # of milliseconds per revolution
const int retries   =  10;	// # of times to retry failing track
const int clockmult =   2;	// sample at 7 MHz * clockmult (1, 2, 4)

struct catweasel_contr c;	// cached info about controller we're using

// ========================================================================
// histogram analysis, modified from Tim Mann's testhist.c program:
//    From cwfloppy-0.2.1 package, copyright (c) 1998 Michael Krause
//    Modified by Timothy Mann
//    Id: testhist.c,v 1.11 2002/12/08 05:36:47 mann Exp $
// ========================================================================

// analyze the histogram of the samples taken and return the two main peaks,
// which correspond to the fast clock transition and the slow clock transition.
// we return 0 if everything is OK, and 1 if there seems to be a problem.
// problems could be:
//     there aren't exactly two peaks
//     the peaks are not well defined
//     the slow pulse isn't roughly 2x the fast pulse
//     the slow pulse isn't roughly 4 us
static int
histo_track(int *fast, int *slow, uint8 *sample, int num_samples)
{
    unsigned int hist[128];
    double peak[3], sd[3], ps[3];
    int i, ii, pk;

    memset(hist, 0, sizeof(hist));
    for(i=0; i<num_samples; i++) {
	hist[(int)(sample[i]&0x7F)]++;
    }

#if 0
    /* Print histogram */
    for(i=0;i<128;i+=8) {
	printf("%3d: %06d %06d %06d %06d %06d %06d %06d %06d\n", i,
	       hist[i+0], hist[i+1], hist[i+2], hist[i+3],
	       hist[i+4], hist[i+5], hist[i+6], hist[i+7]);
    }
#endif

    /* Find two or three peaks */
    i = 0;
    for (pk=0; pk<3; ) {
	int pwidth = 0;
	int psamps = 0;
	int psampsw = 0;
	while (hist[i] < 64 && i < 128) i++;
	while (hist[i] >= 64 && i < 128) {
	    pwidth++;
	    psamps  += hist[i];
	    psampsw += hist[i] * i;
	    i++;
	}
	if (pwidth == 0 || pwidth > 16) {
	    /* Not a real peak */
	    break;
	}
	peak[pk] = ((double) psampsw) / psamps;
	ps[pk] = psamps;
	sd[pk] = 0.0;
	for (ii = i - pwidth; ii < i; ii++) {
	    sd[pk] += hist[ii] * pow((double)ii - peak[pk], 2);
	}
	sd[pk] = sqrt(sd[pk]/((double)psamps-1));
	// fprintf(stderr, "peak %d: mean %.05f, sd %.05f\n", pk, peak[pk], sd[pk]);
	pk++;
    }

    // i've seen disks where there was a broad sweep, maybe due to
    // different rotational speeds when the header was written from
    // when the data was written.  this triggered more than two peaks.
    // here, we try to handle that case by picking the two strongest.
    if (pk != 2) {
#if 0
	// I'm curious how this could happen
	for(i=0;i<3;i++)
	    fprintf(stderr, "%d: ps[]=%f, peak[]=%f\n", i, ps[i], peak[i]);
	for(i=0;i<128;i+=8) {
	    fprintf(stderr, "%3d: %06d %06d %06d %06d %06d %06d %06d %06d\n", i,
		   hist[i+0], hist[i+1], hist[i+2], hist[i+3],
		   hist[i+4], hist[i+5], hist[i+6], hist[i+7]);
	}
#endif
#if 0
	return 1;	// treat it as an error; FM should produce two clear peaks
#else
	if ( (ps[0] < ps[1]) && (ps[0] < ps[2]) ) {
	    // peak 0 loses
	    peak[0] = peak[1]; peak[1] = peak[2];
	      sd[0] =   sd[1];   sd[1] =   sd[2];
	} else if ( (ps[1] < ps[0]) && (ps[1] < ps[2]) ) {
	    // peak 1 loses
	    peak[1] = peak[2];
	      sd[1] =   sd[2];
	} // else peak 2 loses
#endif
    }

    // report the peaks, with 0 for non-existant peaks
    *slow = *fast = 0;
    if (pk > 0)
	*fast = (int)floor(peak[0] + 0.5);
    if (pk > 1)
	*slow = (int)floor(peak[1] + 0.5);

    // now sanity check what we got back

    // for clockmult=2, typically sd[0] < 1.8, sd[1] < 2.5
    if (sd[0] > 2.5 || sd[1] > 3.5)
	return 1;	// peaks aren't well defined

    if ((2*peak[0] < 0.9*peak[1]) ||
        (2*peak[0] > 1.1*peak[1]))
	return 1;	// slow should be close to 2x fast

    return 0;
}

// ========================================================================
// dump out raw data samples to a file, along with an index
// ========================================================================

void
dump_raw_track(FILE *fp, int track, uint8 *sample, int idx_start[])
{
    int i, ii;

    fprintf(fp, "TRACK %d %d\n", track, idx_start[SECTORS] - idx_start[0]);

    // print sector lengths
    fprintf(fp, "# Sector  time (us)  offset  length\n");
    fprintf(fp, "# ======  =========  ======  ======\n");
    for(i=0; i<SECTORS; i++) {
	int j, ticks;
	for(j=idx_start[i], ticks = 0; j<idx_start[i+1]; j++)
	    ticks += (sample[j] & 0x7F);
	fprintf(fp, "INDEX %2d  %9d  %6d  %6d\n", i,
		  (int)(ticks/(clockmult*CWHZ/1000000.0)),
		  (idx_start[i] - idx_start[0]),
		  (idx_start[i+1] - idx_start[i]) );
    }
    fprintf(fp, "\n");

    // dump samples
    for(i = idx_start[0], ii=0; i < idx_start[SECTORS]; i++, ii++) {
	fprintf(fp, "%02X ", sample[i]);
	if ((ii&15) == 15)
	    fprintf(fp, "\n");
    }

    fprintf(fp,"\n\n");
}

// ========================================================================
// FM decoding logic
// decode and save logical data.
//
// this code is very heuristic; I'm sure it will fail for some disks and
// will require hand tuning.  There are a lot of possible improvements,
// but until I find a disk that requires it, I haven't bothered.
// ========================================================================

//#define FM_DEBUG (track==24)	// 1=print diagnostics during fm decode
#define FM_DEBUG (0)	// 1=print diagnostics during fm decode

// decoding phases
enum { FM_PREAMBLE1,	// scanning zeros before
       FM_SYNC1,	// parsing the pre-header sync byte
       FM_HEADER,	// reading header data
       FM_SYNC2,	// parsing the post-header sync byte
       FM_PREAMBLE2,	// scanning zeros before data
       FM_SYNC3,	// parsing the pre-data sync byte
       FM_DATA,		// parsing the data portion
       FM_SYNC4,	// parsing the post-data sync byte
       FM_POSTAMBLE	// trailing junk
     } fm_state;

static char *fm_name[] = {
       "FM_PREAMBLE1",
       "FM_SYNC1",
       "FM_HEADER",
       "FM_SYNC2",
       "FM_PREAMBLE2",
       "FM_SYNC3",
       "FM_DATA",
       "FM_SYNC4",
       "FM_POSTAMBLE"
    };

static int fm_data;		// accumulated bits
static int fm_bits;		// count bits received
static int fm_bytes;		// count bytes received
static int fm_error;		// unrecoverable error
static int fm_first_sector;	// which sector started the data block
static uint8 fm_blk[8192];	// decoded data for current block

static int fm_prev_short;	// used for grouping edges in "1" bits

static void
fm_decode_init(void)
{
    fm_error = 0;

    fm_state = FM_PREAMBLE1;
    fm_bytes = fm_bits = 0;
    fm_prev_short = 0;
}

// called with the stream of samples from the track.
// performs FM demodulation and error detection.
// big: 0=short, 1=long, -1=not in spec
static void
fm_decode_bit(svh_disk_t *disk, int new_sector, int track, int sector, int big, int samp)
{
    const int sync_pattern = 0x1001; /* binary 1_0000_0000_0001 */
    const int save = (disk != NULL);

    if (new_sector) {

	if (FM_DEBUG)
	    printf("# new sector: %d\n", sector);
	if (fm_error)
	    fm_decode_init();

	if (disk != NULL) {
	    disk->trk[track].sector[sector].hdr_bytes = 0;
	    disk->trk[track].sector[sector].data_bytes = 0;
	    // free any data from previous attempts
	    // in the current context, this should never be
	    // required, but I can imagine future changes that
	    // try various decoding options until one works.
	    if (disk->trk[track].sector[sector].header != NULL) {
		free(disk->trk[track].sector[sector].header);
		disk->trk[track].sector[sector].header = NULL;
	    }
	    if (disk->trk[track].sector[sector].data != NULL) {
		free(disk->trk[track].sector[sector].data);
		disk->trk[track].sector[sector].data = NULL;
	    }
	}

	switch (fm_state) {
	    case FM_PREAMBLE1:
		if (sector > 0) {
		    fm_error = 1; // should have gotten something by now
		    return;
		} else {
		    if (FM_DEBUG)
			printf("# decoding sector %d\n", sector);
		    fm_decode_init();
		}
		break;
	    case FM_SYNC1:
	    case FM_HEADER:
	    case FM_SYNC2:
	    case FM_PREAMBLE2:
	    case FM_SYNC3:
		if (FM_DEBUG) {
		    printf("# Error: new sector; giving up decoding from state %s\n",
			    fm_name[fm_state]);
		} else {
		    fm_error = 1;
		    return;
		}
		// fall through
	    case FM_POSTAMBLE:
		if (FM_DEBUG)
		    printf("# decoding sector %d\n", sector);
		fm_decode_init();
		break;
	    default:
		break;
	}
    } // if (new_sector)

    if (1 && FM_DEBUG)
	printf("samp=%d, big=%d\n", samp, big);

    // if we already gave up, don't try to sync again
    if (fm_error)
	return;

    // handle junk bits
    if (big < 0) {
	switch (fm_state) {
	    case FM_PREAMBLE1:
	    case FM_PREAMBLE2:
#if 0
		// it is OK to get junk during preamble
		if (samp < 44) {
		    big = 0;  // map it to a short (start of sync?)
		} else {
		    fm_bits = fm_bytes = 0;
		    fm_prev_short = 0;
		    return; // ignore it
		}
		break;
#else
		// fall through
#endif
	    case FM_POSTAMBLE:
		// it is OK to get junk during postamble
		fm_bits = fm_bytes = 0;
		fm_prev_short = 0;
		return; // ignore it
	    case FM_SYNC1:
	    case FM_SYNC2:
	    case FM_SYNC3:
	    case FM_SYNC4:
#if 1
		// FIXME: experimental -- seems to be effective
		if (FM_DEBUG) {
		    printf("\n# WARNING: Got bad duration (%d) during state %s\n", samp, fm_name[fm_state]);
		    printf("# mapping it to a short bit\n");
		}
		big = 0;
#endif
		break;
	    case FM_HEADER:
	    case FM_DATA:
		if (FM_DEBUG) {
		    if (fm_bytes%16 != 0)
			printf("\n");
		    printf("# ERROR: Got bad duration (%d) during state %s\n", samp, fm_name[fm_state]);
		}
		fm_error = 1;
		return;
	    default:
		assert(0);
	} // switch (fm_state)
    } // if (big<0)

    switch (fm_state) {

	case FM_PREAMBLE1:
	case FM_PREAMBLE2:
	    if (big) {
		// count how many zero bits we get in a row
		fm_bits++;
	    } else if (fm_bits < 16) {
		if (FM_DEBUG)
		    printf("\n# lost %s sync after %d bits\n",
			    fm_name[fm_state], fm_bits);
		fm_bits = 0; // lost sync
	    } else {
		if (FM_DEBUG)
		    printf("# leaving %s sync after %d bits\n",
			    fm_name[fm_state], fm_bits);
		fm_state = (fm_state == FM_PREAMBLE1) ? FM_SYNC1 : FM_SYNC3;
		fm_bits = fm_bytes = 0;
		fm_prev_short = 0;
	    }
	    break;

	// we enter this state after already seeing the first couple of
	// clocks of the sync token (a short clock then a slow clock).
	// the "fm_bits" is really a count of the clocks seen, not bits.
	case FM_SYNC1:
	case FM_SYNC2:
	case FM_SYNC3:
	case FM_SYNC4:
	    if ( ((sync_pattern >> fm_bits) & 1) == big) {
		if (FM_DEBUG)
		    printf("# %d: sync bit %d\n", big, fm_bits);
		fm_bits++;
		if (fm_bits == 13) {
		    if (FM_DEBUG)
			printf("# leaving %s\n", fm_name[fm_state]);
		    switch (fm_state) {
			case FM_SYNC1: fm_state = FM_HEADER;
					if (FM_DEBUG)
					    printf("# Header:\n");
					break;
			case FM_SYNC2: fm_state = FM_PREAMBLE2;
					break;
			case FM_SYNC3: fm_state = FM_DATA;
					if (FM_DEBUG)
					    printf("# Data:\n");
					break;
			case FM_SYNC4: fm_state = FM_POSTAMBLE;
					if (FM_DEBUG && (sector < SECTORS-1))
					    printf("# waiting for sector %d\n", sector+1);
					break;
			default: assert(0);
		    }
		    fm_bits = fm_bytes = 0;
		    fm_prev_short = 0;
		}
	    } else {
		if (FM_DEBUG)
		    printf("# bailed on %s after %d sync bits\n",
			    fm_name[fm_state], fm_bits);
		switch (fm_state) {
		    case FM_SYNC1: fm_state = FM_PREAMBLE1; break;
		    case FM_SYNC3: fm_state = FM_PREAMBLE2; break;
		          default:
				if (FM_DEBUG) {
				    printf("# bailed on %s after %d sync bits\n",
					    fm_name[fm_state], fm_bits);
				}
				fm_state = FM_POSTAMBLE;
				fm_error = 1;
				break;
		}
		fm_bits = fm_bytes = 0;
	    }
	    break;

	case FM_HEADER:
	case FM_DATA:
	    if (big) {
		if (fm_prev_short) {
		    fm_prev_short = 0;
		    if (fm_bits == 0) {
			// could be the start of a sync token
			// check the CRC.  the helios board uses a "9401" chip,
			// AKA 74F401.  it implements the CCITT-16 checksum.
			unsigned short crc;
			if (FM_DEBUG && (fm_bytes%16 != 0))
			    printf("\n");
			crc = calc_crc(0xFFFF, fm_blk, fm_bytes);
			if (FM_DEBUG)
			    printf("# crc = %04X\n", crc);
			if (crc != 0x0000) {
			    fm_error = 1;
			    if (FM_DEBUG) {
				printf("# crc = %04X\n", crc);
				fprintf(stderr, "# Error: crc = %04X, sector %d, state=%s\n",
						crc, sector, fm_name[fm_state]);
			    }
			}
			if (FM_DEBUG) {
			    if (fm_state == FM_HEADER) {
				if (fm_bytes != 15)
				    printf("# unexpected header length: %d bytes\n", fm_bytes);
			    } else {
				if ((fm_bytes < 3 || fm_bytes > 4097))
				    printf("# unexpected data length: %d bytes\n", fm_bytes);
			    }
			    printf("# decoded %d bytes\n", fm_bytes);
			    printf("# finished %s; moving to %s\n",
				    fm_name[fm_state], fm_name[fm_state+1]);
			}
			if (FM_DEBUG && (fm_state == FM_HEADER)) {
			    printf("# this: sector %d, track %d\n", fm_blk[0], fm_blk[1]);
			    if (fm_blk[3] & 0x80)
				printf("# fwd:  last sector (blk len=%d)\n", 0x7FFF & (fm_blk[2] + 256*fm_blk[3]));
			    else
				printf("# fwd:  sector %d, track %d\n", fm_blk[2], fm_blk[3]);
			    if (fm_blk[4]==0xFF && fm_blk[5]==0xFF)
				printf("# back: none\n");
			    else
				printf("# back: sector %d, track %d\n", fm_blk[4], fm_blk[5]);
			    printf("# file id     0x%04X\n", fm_blk[6]+256*fm_blk[7]);
			    printf("# blk length  %d sectors\n", fm_blk[8]);
			    printf("# blk length  %d bytes\n", fm_blk[9]+256*fm_blk[10]);
			    printf("# rsvd[0]     0x%04X\n",   fm_blk[11]+256*fm_blk[12]);
			}

			if (save && (fm_state == FM_HEADER)) {
			    fm_first_sector = sector; // remember where it started
			    disk->trk[track].sector[sector].hdr_error = fm_error;
			    disk->trk[track].sector[sector].hdr_bytes = fm_bytes-2;
			    disk->trk[track].sector[sector].header = safe_malloc(fm_bytes-2);
			    memcpy(disk->trk[track].sector[sector].header, fm_blk, fm_bytes-2);
			} else if (save && (fm_state == FM_DATA)) {
			    disk->trk[track].sector[fm_first_sector].data_error = fm_error;
			    disk->trk[track].sector[fm_first_sector].data_bytes = fm_bytes-2;
			    disk->trk[track].sector[fm_first_sector].data = safe_malloc(fm_bytes-2);
			    memcpy(disk->trk[track].sector[fm_first_sector].data, fm_blk, fm_bytes-2);
			}

			fm_bits = fm_bytes = 0;
			fm_state = (fm_state == FM_HEADER) ? FM_SYNC2 : FM_SYNC4;
		    } else {
			if (FM_DEBUG)
			    printf("# ERROR: illegal transition (unpaired short) after "
					"%d bytes, %d bits\n", fm_bytes, fm_bits);
			fm_error = 1;
		    }
		}
	    } else if (fm_prev_short) {
		fm_prev_short = 0;  // second bit of pair = "1"
	    } else {
		// first half of a "1" bit?
		fm_prev_short = 1;
		break;
	    }
	    fm_data = (fm_data << 1) | (!big);	// add data
	    fm_bits++;
	    if (fm_bits == 8) {
		fm_data &= 0xFF;
		if (FM_DEBUG)
		    printf("%02X ", fm_data);
		fm_blk[fm_bytes] = fm_data;
		fm_data = 0x00;
		fm_bits = 0;
		fm_bytes++;
		if (FM_DEBUG && (fm_bytes%16 == 0))
		    printf("\n");
	    }
	    break;

	case FM_POSTAMBLE:
	    return;	// ignore data until the next sector mark

	default:
	    assert(0);
    }
}

// decode bits
//
// the format uses simple FM encoding, where there is two clocks (start and
// middle) during a "1" bit and just one clock (start) during a "0" bit.
// bits are encoded at 250 KHz nominal, which is 4 uS, which comes out to
// (4*CWHZ*clockmult) ticks per bit.  with a clockmult of two, that is 56
// ticks per bit.
//
// preable is 15 bytes of zeros and one sync byte.  the sync byte is
// distinguised by a missing clock.  it shows up to us as this sequence
// (l=long, s=short):
//    llll...(zero bytes)...llllslsssssssssssl
// normally there are always two short pulses in a row to identify a "1"
// but in this case we get long,short,long.
//
// we return 0 on success, and non-zero on failure.

static int
decode_track_data(svh_disk_t *disk, int track, int fast, int slow,
		    uint8 *sample, int num_samples)
{
    const int save = (disk != NULL);

#if 0
    int fast_low  = fast-8;	// thresholds for sample classification
    int fast_high = fast+999;	// FIXME: these +/- windows are arbitrary and
    int slow_low  = slow-999;	//        should be a function of clockmult.
    int slow_high = slow+12;	//        these are good for clockmult=2.
#else
// the two windows have been effectively turned into a simple threshold
    int fast_low  = 0;
    int fast_high = (fast+slow)/2;
    int slow_low  = fast_high+1;
    int slow_high = 127;
#endif

    int prev_idx_bit = (~sample[0] & 0x80);  // force new_sector
    int sector = -1;  // first sample will increment it
    int any_err = 0;
    int i;

    fm_decode_init();

    if (FM_DEBUG)
	printf("# ====== track %d, contains %d samples ======\n", track, num_samples);

    // if the threshold buckets overlap, then center them
    if (fast_high > slow_low)
	fast_high = slow_low = (fast+slow+1)/2;

    // HISTORY:
    //    As an experiment, I modified this code to compute the midpoint
    //    between the fast and slow peaks, then swept the midpoint until
    //    I got a successful decode.  The pattern was +/- 0, +/- 1, ...
    //    to +/- 10.  However, in a dozen disks that had errors, this
    //    heuristic never improved anything, so it has been abandoned.
    //
    // FIXME:
    //    another possibility is if there are a small number of ambiguous
    //    clocks, repeatedly decode with all possible combinations of
    //    guesses.  for this to be meaningful, the high/low fast/slow
    //    windows must be non-overlapping so we can detect the ambiguous
    //    cases.
    //
    //    finally, it would be possible to decode one logical block at a
    //    time and fiddle the ambiguous combinations for a given block.
    //    we can also cut down by the fact that some of the bad tokens
    //    happen during preamble/postamble so we don't need to worry about
    //    fiddling them.

    for(i=0; i<num_samples; i++) {

	// in decoding sectors, remember that we must ignore all
	// the odd ones, and that the last sector looks like two
	// sectors because of the index hole.
	int idx_bit = (sample[i] & 0x80);
	int samp    = (sample[i] & 0x7F);
	int new_sector = (idx_bit && !prev_idx_bit);
	int mapped_sector;
	sector += new_sector;
	prev_idx_bit = idx_bit;
	mapped_sector = sector/2;
	new_sector &= ~(sector & 1) & (mapped_sector < SECTORS);

	if ((samp >= fast_low) && (samp <= fast_high)) {
	    fm_decode_bit(disk, new_sector, track, mapped_sector, 0, samp);
	} else if ((samp >= slow_low) && (samp <= slow_high)) {
	    fm_decode_bit(disk, new_sector, track, mapped_sector, 1, samp);
	} else {
	    fm_decode_bit(disk, new_sector, track, mapped_sector, -samp, samp);
	}

	if (!save && fm_error)
	    return 1;

	any_err |= fm_error;
    }

    if (FM_DEBUG)
	printf("\n"); // blank line after sector's data

    return any_err;
}


// ========================================================================
// read real disk and process it a track at a time,
// optionally saving it to the disk data structure.
// ========================================================================

#define AVOID_CW_OVERFLOW 0

#if AVOID_CW_OVERFLOW
// how long to capture to the catweasel buffer.  if we make it too short
// (near 1.0*rev_ms), we will have a hard time capturing a complete
// revolution starting at sector 0 and will waste a lot of time until we
// happen to get it right.  if we make it too long, we will overflow the
// catweasel capture buffer.  empirically, 1.7 is too long for some tracks.
// in the worst case, a track has nothing but 1 bits, so we have:
//    (16 sectors)*(325 bytes/sector)*(8 bits/byte)*(2 transitions/bit)
// or 83200 samples per revoltion.  since the catweasel has a 128KB buffer,
// we can store only 1.57 revolutions worth.  we will overflow sometimes
// since windows' sleep() only guarantees a minimum sleep time, not the
// actual sleep time.
#define capture_time ((int)(1.5 * rev_ms))
#else
// make it really long and accept that we will often overflow the buffer.
// this seems to work just fine.  we don't want to set the multiplier too
// high since we waste time unneccessarily.
#define capture_time ((int)(2.2 * rev_ms))
#endif

// read a track and return a complete track, starting at sector 0.
// one complication is that the disk format is hard sectored we can't
// simply ask the catweasel to read index hole to index hole; we must
// use a timed read.  the requirement that the buffer starts at sector 0
// comes about because PTDOS stores "supersectors" that cross sector
// boundaries, so we must capture the whole track in one go vs. trying
// to stitch together the buffer where it wraps around.  that kind of
// approach could work, but it is more complicated than just reading
// the track repeatedly until we get it right.

// sample buffer is passed in, as is an array to hold SECTORS+1 sector start points.
// note that the sector_offset[0] most likely isn't zero.
// returns 0 on success, -999 if no disk, non-zero on failure.
static int
read_track(int drive, int track, uint8 *sample, int *sector_offset)
{
    const int rpm       = 360;        // disk rotational speed
    const int sectors   = HSECTORS;   // sectors per track
    const int sector_us = (60 * 1000000) / (rpm * sectors);  // microsec/track
#define HALF_IDX(x) (((x) > sector_us*0.4) && ((x) < sector_us*0.6))
#define FULL_IDX(x) (((x) > sector_us*0.8) && ((x) < sector_us*1.2))

    #define MAX_IDXS 100 // most number of index holes captured
    int idx_us[MAX_IDXS], idx_start[MAX_IDXS];

    int length_retry = 0;  // # of times failed due to length problem
    int no_idx = 0;	   // # of times index hole wasn't seen
    int retry;             // # of retries for other reasons

    catweasel_seek(&c.drives[drive], track);

    for(retry = 0; retry < retries; ) {
	int i, prev_bit, ticks, idx_marks, first_idx_mark;
	int first, last;

	// in case of retries, randomize the starting phase so
	// we don't fall into rut if we just happen to process
	// things in lockstep with disk rotation speed.
	usleep(rev_ms * 1000);

	catweasel_fillmem(&c, 0xFF);
	catweasel_read(&c.drives[drive], side, clockmult, capture_time);

	// figure out how much catweasel captured
	// note: if catweasel_read() filled the buffer entirely then
	//       appended the stop pattern, they show up as the first
	//       seven samples in the buffer.  in that case, we just
	//       ignore the first seven samples and process from there
	//       until the end of the buffer.
	first = 1;
	last = -1;
	for(i=0; i<CW_MEMSIZE; i++) {
	    sample[i] = catweasel_get_byte(&c);
	    if ((i > 6) &&
		(sample[i-6] == 0xFF) &&
		(sample[i-5] == 0xFF) && (sample[i-4] == 0x00) &&
		(sample[i-3] == 0xFF) && (sample[i-2] == 0x00) &&
		(sample[i-1] == 0xFF) && (sample[i-0] == 0x00)) {
		last = i-6;
		break;
	    }
	}

#if AVOID_CW_OVERFLOW
	if (last < 0) {
	    if (++length_retry < retries)
		continue;
	    // if we record for too long or the bit density is much higher
	    // than we'd expect, we could always overflow the buffer
	    fprintf(stderr, "\nError: track %d exceeded retry limit on buffer overflow\n", track);
	    fprintf(stderr, "       dumping buffer anyway\n");
	    first = 2;
	    last = CW_MEMSIZE-1;
	}
#else // !AVOID_CW_OVERFLOW
	if (last < 0) {
	    // either nothing was written, or we filled the buffer on read.
	    // we assume the latter and trust that any garbage in the first
	    // case will show up as an error later.
	    // fprintf(stderr, "overflowed buffer\n");
	    first = 6;
	    last  = CW_MEMSIZE-1;
	}
#endif

	// figure out where the index marks are.  because live sector data
	// can cross sector boundaries except for the start of sector 0,
	// make sure we've captured a whole revolution without interruption
	// so that we don't need to splice end to front.
	idx_marks = 0;
	prev_bit  = (sample[1] & 0x80);  // sample 0 is always 0x7F or 0xFF
	ticks     = 0;
	for(i=first; i<=last; i++) {
	    int bit = (sample[i] & 0x80);
	    ticks  += (sample[i] & 0x7F);
	    if (bit && !prev_bit) {
		// start of new index hole
		idx_start[idx_marks] = i;
		if (idx_marks > 0)
		    idx_us[idx_marks-1] = (int)(ticks/(clockmult*CWHZ/1000000.0));
		idx_marks++;
		ticks = 0;
	    }
	    prev_bit = bit;
	}

	if (0) {
	    // print sector lengths
	    printf("# Sector  time (us)  offset  length\n");
	    printf("# ======  =========  ======  ======\n");
	    for(i=1; i<idx_marks-1; i++) {
		int j;
		printf("# %6d  %9d  %6d  %6d\n", i,
			   idx_us[i],
			   idx_start[i],
			  (idx_start[i+1] - idx_start[i]) );
	    }
	}

	// sectors come 5.2 ms apart.  a 33rd hole comes between the index
	// hole for sectors 31 and 0.  thus, sector 0 starts after two
	// short gaps of 2.6 ms each.
	first_idx_mark = -1;
	for(i=1; i<idx_marks-2; i++) {  // skip first one: it is probably partial sector
	    if (  HALF_IDX(idx_us[i  ]) &&
		  HALF_IDX(idx_us[i+1]) &&
		  FULL_IDX(idx_us[i+2]) ) {
		first_idx_mark = i+2;
		break;
	    }
	}

	// detect if there is a disk in the drive by abscence of index mark
	if (first_idx_mark < 0) {
	    no_idx++;
	    if (no_idx > 2)
		return -999;	// no index hole seen
	    continue; // recapture track
	}
	no_idx = 0;

	if (idx_marks < 33) {
	    fprintf(stderr, "\nretrying ... didn't see a full revolution\n");
	    retry++;  // something seriously wrong?
	    continue; // recapture track
	}
#if 1 // these are things specific to the helios format
	if (first_idx_mark+33 >= idx_marks) {
	    // didn't capture 32 sectors (+ index hole) after start sector
	    continue;
	}
	for(i=first_idx_mark; i<first_idx_mark+31; i++) {
	    if (!FULL_IDX(idx_us[i])) {
		// didn't capture clean track image
		continue;
	    }
	}
	for(i=first_idx_mark+31; i<first_idx_mark+33; i++) {
	    if (!HALF_IDX(idx_us[i])) {
		// didn't capture clean track image
		continue;
	    }
	}
	if (!FULL_IDX(idx_us[first_idx_mark+33])) {
	    // didn't capture clean track image
	    continue;
	}

	// PTDOS ignores every other index hole, so effectively there are
	// 16 sectors per track
	for(i=0; i<SECTORS; i++) {
	    sector_offset[i] = idx_start[first_idx_mark + 2*i];
	}
	// the last sector has the index mark and looks like sector 31 & 32.
	// we ignore index 32.  index 33 should be sector 0's sector mark.
	sector_offset[SECTORS] = idx_start[first_idx_mark + 2*SECTORS+1];
#else
	// raw, unaligned capture
	for(i=0; i<SECTORS+1; i++) {
	    sector_offset[i] = idx_start[i];
	}
#endif

	return 0;  // success

    } // while (retry < retries);

    return 1;  // failure
}


static void
cleanup()
{
    catweasel_free_controller(&c);
}

static void
handler(int sig)
{
    cleanup();
    signal(sig, SIG_DFL);
    kill(getpid(), sig);
}


int
read_disk(char *filename, char *label, int drive, int qdir, svh_disk_t *disk)
{
    const int cw_mk = 3;	// 3=PCI version of catweasel
    const int track_start = (qdir) ? 25 : 0;
    const int track_final = (qdir) ? 25 : TRACKS-1;
    int failing_tracks = 0;
    FILE *fp = NULL;		// output file
    int port = 0;		// only one catweasel in system

    uint8 RAM[CW_MEMSIZE];
    int ch, track;

    /* Keep drive from spinning endlessly on (expected) signals */
    signal(SIGHUP,  handler);
    signal(SIGINT,  handler);
    signal(SIGQUIT, handler);
    signal(SIGPIPE, handler);
    signal(SIGTERM, handler);

    /* Start Catweasel */
    port = pci_find_catweasel(port);

    catweasel_init_controller(&c, port, cw_mk);
    ch = catweasel_memtest(&c);
    if (ch) {
	printf("Detected Catweasel MK%d at port 0x%x\n", cw_mk, port);
	fflush(stdout);
    } else {
	fprintf(stderr, "cw2dmk: Failed to detect Catweasel at port 0x%x\n", port);
	return 1;
    }

    catweasel_detect_drive(&c.drives[drive]);

    /* Error if drive not detected */
    if (c.drives[drive].type == 0) {
	fprintf(stderr, "helios: Failed to detect any drives\n");
	cleanup();
	return 1;
    }

    if (filename != NULL) {
	fp = fopen(filename, "w");
	if (fp == NULL) {
	    fprintf(stderr, "Error opening file '%s' for writing\n", filename);
	    return 1;
	}
    }

    /* Select drive, start motor, wait for spinup */
    catweasel_select(&c, !drive, drive);
    catweasel_set_motor(&c.drives[drive], 1);
    catweasel_usleep(spinup_ms * 1000);

    fflush(stdout);

    // magic string identifying file format
    if (fp != NULL) {
	fprintf(fp, "HELIOS raw\n");

    // optional disk label
	if (label == NULL) {
	    fprintf(fp, "LABEL extracted from a real disk using a catweasel card\n");
	    // FIXME: second LABEL to include date string?
	} else {
	    label_emit(fp, label);
	}

	fprintf(fp, "# clockmult = %d, dumping %d ms per track\n", clockmult, capture_time);
    }

    for(track=track_start; track <= track_final; track++) {

	int retry;
	int bad_track;

	fprintf(stderr, "\rreading track %d", track);

	for(retry=0; retry<retries; retry++) {
	    int fast, slow;  // mean value of fast and slow edges, from histogram
	    int idx_start[SECTORS+1];
	    int failure;

	    bad_track = 0;

	    // read a nicely aligned track
	    failure = read_track(drive, track, RAM, idx_start);
	    if (failure == -999) {
		fprintf(stderr, "\nNo index hole seen -- is the drive empty?\n");
		fclose(fp);
		exit(-1);	// just quit -- don't return error code
	    } else if (failure) {
		fprintf(stderr, "giving up on this track\n");
		bad_track = 1;
	    }

	    // determine signal peaks
	    failure = histo_track(&fast, &slow, &RAM[idx_start[0]], idx_start[SECTORS] - idx_start[0]);

	    // sanity check track before dumping it
	    if (!failure) {
		failure = decode_track_data(NULL, track, fast, slow,
					    &RAM[idx_start[0]],
					    idx_start[SECTORS] - idx_start[0]);
	    }
	    if (failure) {
		if (retry == 0)
		    fprintf(stderr, "\n");
		fprintf(stderr, "couldn't decode ... retrying\n");
		if (retry < retries-1)
		    continue; // retry
		fprintf(stderr, "retry count exceeded ... using it anyway\n");
		bad_track = 1;
	    }

	    // dump raw samples if it was requested
	    if (fp != NULL) {
		fprintf(fp, "# WARNING: track %d not captured cleanly\n", track);
		dump_raw_track(fp, track, RAM, idx_start);
	    }

	    // decode it and save it to the disk data structure
//printf("Doing track decode, idx_start=%d, idx_last=%d\n", idx_start[0], idx_start[SECTORS]);
	    (void)decode_track_data(disk, track, fast, slow,
				    &RAM[idx_start[0]],
				    idx_start[SECTORS] - idx_start[0]);
//printf("Done track decode\n");

	    break; // we don't need to retry
	}

	if (bad_track)
	    failing_tracks++;

    } // for (track)

    fprintf(stderr, "\n");
    if (failing_tracks > 0) {
	fprintf(stderr, "Disk read with %d failing tracks\n", failing_tracks);
    }

    cleanup();

    return (failing_tracks != 0);  // OK=0, 1=error
}

// ========================================================================
// read .raw disk image from file and process it a track at a time
// ========================================================================

// read the first line of the file and attempt to classify it
int
file_is_raw(const char *filename)
{
    char *line = get_first_line_of_file(filename);
    return (line != NULL) && (strcmp(line,"HELIOS raw") == 0);
}

int
read_raw_file(const char *filename, svh_disk_t *disk)
{
    int failing_tracks = 0;

    uint8 RAM[CW_MEMSIZE];
    int i, track;
    FILE *fp;

    if (!file_is_raw(filename))
	return 1;

    fp = fopen(filename, "r");
    assert(fp != NULL);

    for(track=0; track<TRACKS; track++) {

	int  idx_start[SECTORS+1];	// starting offset of given track
	char line[300];			// holds line to parse
	int fast, slow;			// mean value of fast and slow edges, from histogram
	int failure;

	// scan for start of specified track
	while (1) {
	    int trk;
	    if (fgets(line, sizeof(line)-1, fp) == NULL) {
		fprintf(stderr, "Error: can't find track %d\n", track);
		fclose(fp);
		return 1;
	    }
	    if ( (sscanf(line, "TRACK %d", &trk) == 1) &&
		 (trk == track) )
		break; // found the start of the track
	    if (strncmp(line, "LABEL ", 6) == 0) {
		strip_line_ending(line);
		label_append( &(disk->label), &line[6] );
		continue;
	    }
	}
	fprintf(stderr, "\rreading track %d", track);

	// scan for the sector index table
	for(i=0; i<SECTORS; i++) {
	    int p1, p2, p3;  // sector, offset, length
	    while (1) {
		if (fgets(line, sizeof(line)-1, fp) == NULL) {
		    fprintf(stderr, "\nError: can't read index table entry %d for track %d\n", i, track);
		    fclose(fp);
		    return 1;
		}
		if (sscanf(line, "INDEX %d %*d %d %d", &p1, &p2, &p3) == 3)
		    break;
	    }
	    if (p1 != i) {
		fprintf(stderr, "\nError: index table in wrong order for track %d\n", track);
		fclose(fp);
		return 1;
	    }
	    idx_start[i  ] = p2;
	    idx_start[i+1] = p2+p3;
	}

	// now pull down bytes
	for(i=0; i<idx_start[SECTORS]; i++) {
	    int byte;
	    char p[300];
	    if (fscanf(fp, "%s", p) != 1) {
		fprintf(stderr, "\nError: couldn't read byte %d of track %d\n", i, track);
		fclose(fp);
		return 1;
	    }
	    byte = (int)strtol(p, (char**)NULL, 16);
	    if (byte < 0 || byte > 255) {
		fprintf(stderr, "\nError: byte %d of track %d is out of range\n", i, track);
		fclose(fp);
		return 1;
	    }
	    RAM[i] = (uint8)byte;
	}

	// determine signal peaks
	failure = histo_track(&fast, &slow, &RAM[idx_start[0]], idx_start[SECTORS] - idx_start[0]);
	if (failure) {
	    fprintf(fp,      "# bad histogram: fast=%d, slow=%d\n", fast, slow);
	    fprintf(stderr, "\n# bad histogram: fast=%d, slow=%d\n", fast, slow);
	}

	failure = decode_track_data(disk, track, fast, slow, &RAM[idx_start[0]],
				    idx_start[SECTORS] - idx_start[0]);
	if (failure) {
	    fprintf(stderr, "\nerror decoding track %d\n", track);
	    failing_tracks++;
	}

    } // for (track)

    fprintf(stderr, "\n");

    if (failing_tracks > 0) {
	fprintf(stderr, "Disk read with %d failing tracks\n", failing_tracks);
    }

    return (failing_tracks != 0);  // OK=0, 1=error
}

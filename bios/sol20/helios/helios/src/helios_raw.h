/* Author: Jim Battle, 2004
 *
 * Based on:
 *    cw2dmk: Dump floppy disk from Catweasel to .dmk format.
 *    Copyright (C) 2000 Timothy Mann
 *    Id: cw2dmk.c,v 1.28 2003/06/19 05:53:28 mann Exp $
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

#ifndef _HELIOS_RAW_H_
#define _HELIOS_RAW_H_

#include "helios.h"

// read the first line of the file and attempt to classify it
int file_is_raw(const char *filename);

// dump out raw data samples to a file, along with an index
void dump_raw_track(FILE *fp, int track, uint8 *sample, int idx_start[]);

// read real disk and process it a track at a time,
// optionally dumping it to a file.  qdir causes just
// track 25 to be read (for quick PTDOS directory listing).
int read_disk(char *filename, char *label, int drive, int qdir, svh_disk_t *disk);

// read .raw disk image from file and process it a track at a time
int read_raw_file(const char *filename, svh_disk_t *disk);

#endif // _HELIOS_RAW_H_

# FIXME: I really should learn how to use make properly

SRC=src
OBJ=obj
CCFLAGS=-g -c

.PHONY: helios testhist tags clean

# what to build if "make" is invoked with no arguments
default: helios testhist

$(OBJ)/wildcard.o:	$(SRC)/wildcard.c $(SRC)/wildcard.h
	gcc $(CCFLAGS) -o $@ $(SRC)/wildcard.c

$(OBJ)/helios_raw.o:	$(SRC)/helios_raw.c $(SRC)/helios_raw.h \
			$(SRC)/helios.h \
			$(SRC)/cwfloppy.h \
			$(SRC)/cwpci.h
	gcc $(CCFLAGS) -o $@ $(SRC)/helios_raw.c

$(OBJ)/helios_byt.o:	$(SRC)/helios_byt.c $(SRC)/helios_byt.h \
			$(SRC)/helios.h
	gcc $(CCFLAGS) -o $@ $(SRC)/helios_byt.c

$(OBJ)/helios_svh.o:	$(SRC)/helios_svh.c $(SRC)/helios_svh.h \
			$(SRC)/vdisk_svh_lib.h \
			$(SRC)/vdisk_svd.h \
			$(SRC)/helios.h
	gcc $(CCFLAGS) -o $@ $(SRC)/helios_svh.c

$(OBJ)/helios_ptdos.o:	$(SRC)/helios_ptdos.c $(SRC)/helios_ptdos.h \
			$(SRC)/helios.h \
			$(SRC)/wildcard.h
	gcc $(CCFLAGS) -o $@ $(SRC)/helios_ptdos.c

$(OBJ)/cwpci.o: $(SRC)/cwpci.c $(SRC)/cwpci.h
	gcc $(CCFLAGS) -o $@ $(SRC)/cwpci.c

$(OBJ)/catweasl.o: $(SRC)/catweasl.c $(SRC)/cwfloppy.h
	gcc $(CCFLAGS) -o $@ $(SRC)/catweasl.c

$(OBJ)/crc.o: $(SRC)/crc.c
	gcc $(CCFLAGS) -o $@ $(SRC)/crc.c

$(OBJ)/vdisk_svd.o: $(SRC)/vdisk_svd.c $(SRC)/vdisk_svd.h
	gcc $(CCFLAGS) -o $@ $(SRC)/vdisk_svd.c

$(OBJ)/vdisk_svh_lib.o: $(SRC)/vdisk_svh_lib.c $(SRC)/vdisk_svh_lib.h \
			$(SRC)/vdisk_svd.h
	gcc $(CCFLAGS) -o $@ $(SRC)/vdisk_svh_lib.c

$(OBJ)/main.o:	$(SRC)/main.c \
		$(SRC)/helios.h $(SRC)/helios_byt.h $(SRC)/helios_ptdos.h
	gcc $(CCFLAGS) -o $@ $(SRC)/main.c

$(OBJ)/testhist.o: $(SRC)/testhist.c
	gcc $(CCFLAGS) -o $@ $(SRC)/testhist.c

HELIOS_OBJS = \
	$(OBJ)/helios_raw.o \
	$(OBJ)/helios_byt.o \
	$(OBJ)/helios_svh.o \
	$(OBJ)/helios_ptdos.o \
	$(OBJ)/wildcard.o \
	$(OBJ)/cwpci.o \
	$(OBJ)/catweasl.o \
	$(OBJ)/crc.o \
	$(OBJ)/vdisk_svd.o \
	$(OBJ)/vdisk_svh_lib.o \
	$(OBJ)/main.o

helios.exe: $(HELIOS_OBJS)
	gcc -g -o $@ $(HELIOS_OBJS)

TESTHIST_OBJS = \
	$(OBJ)/cwpci.o \
	$(OBJ)/catweasl.o \
	$(OBJ)/testhist.o

testhist.exe: $(TESTHIST_OBJS)
	gcc -g -o $@ $(TESTHIST_OBJS)

#######################################################
# phony targets

helios:   helios.exe

testhist: testhist.exe

# generate a "tags" file in the source directory
tags:
	make -C src tags

# get rid of generated files
clean:
	del testhist.exe
	del helios.exe
	del $(OBJ)\*.o


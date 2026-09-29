# Build efi_qvi.ko against a kernel tree.
#   make -f efi_qvi.Makefile                       # this box's running kernel
#   make -f efi_qvi.Makefile KDIR=/path/to/tree    # cross build
# The result belongs in platform/<platform>/files/kernel_modules/<uname -r>/.
obj-m += efi_qvi.o
KDIR ?= /lib/modules/$(shell uname -r)/build
all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules
clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

// SPDX-License-Identifier: GPL-2.0
/*
 * efi_qvi - read-only view of the EFI variable store's free space.
 *
 * Why this exists: efi_pstore's panic path goes through
 * query_variable_store_nonblocking() (arch/x86/platform/efi/quirks.c), which refuses
 * the write once remaining_size - size drops below EFI_MIN_RESERVE and deliberately
 * skips garbage collection because it runs from a crash handler. On firmware that
 * does not reclaim deleted variables (Firewalla Gold v1, BIOS FWGOLDA03) the store
 * therefore fills up and efi-pstore goes permanently silent. KernelCrashMonitor.js
 * works around that by writing a throwaway variable to force collection - but an
 * NVRAM write is a flash write, so it has to know whether one is actually needed
 * rather than guess.
 *
 * efivarfs grew a real statfs() (backed by QueryVariableInfo) only in 6.x; on 4.15
 * and 5.4 it is simple_statfs and reports zeros, leaving these numbers reachable
 * from kernel code only. Hence this module.
 *
 * QueryVariableInfo is a query - loading this module writes nothing to NVRAM. The
 * values are sampled once at init and exposed read-only, so the caller loads, reads
 * and unloads:
 *
 *     insmod efi_qvi.ko
 *     cat /sys/module/efi_qvi/parameters/remaining_size
 *     rmmod efi_qvi
 */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/efi.h>

/* the same attributes efi_pstore writes its records with */
#define QVI_ATTRS (EFI_VARIABLE_NON_VOLATILE | \
		   EFI_VARIABLE_BOOTSERVICE_ACCESS | \
		   EFI_VARIABLE_RUNTIME_ACCESS)

static unsigned long long storage_size;
static unsigned long long remaining_size;
static unsigned long long max_variable_size;

module_param(storage_size, ullong, 0444);
MODULE_PARM_DESC(storage_size, "total NON_VOLATILE variable storage, in bytes");
module_param(remaining_size, ullong, 0444);
MODULE_PARM_DESC(remaining_size, "free NON_VOLATILE variable storage, in bytes");
module_param(max_variable_size, ullong, 0444);
MODULE_PARM_DESC(max_variable_size, "largest single variable the firmware accepts, in bytes");

static int __init efi_qvi_init(void)
{
	efi_status_t status;

	if (!efi_enabled(EFI_RUNTIME_SERVICES)) {
		pr_info("efi_qvi: EFI runtime services are not enabled\n");
		return -ENODEV;
	}
	if (!efi.query_variable_info) {
		pr_info("efi_qvi: firmware exposes no QueryVariableInfo\n");
		return -ENODEV;
	}

	status = efi.query_variable_info(QVI_ATTRS, &storage_size,
					 &remaining_size, &max_variable_size);
	if (status != EFI_SUCCESS) {
		pr_warn("efi_qvi: QueryVariableInfo failed, status=0x%lx\n",
			(unsigned long)status);
		return -EIO;
	}

	pr_info("efi_qvi: storage_size=%llu remaining_size=%llu max_variable_size=%llu\n",
		storage_size, remaining_size, max_variable_size);
	return 0;
}

static void __exit efi_qvi_exit(void) { }

module_init(efi_qvi_init);
module_exit(efi_qvi_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Firewalla");
MODULE_DESCRIPTION("Read-only QueryVariableInfo view of the EFI variable store");
MODULE_VERSION("1.0");

# Optional: force libbpf load API when headers do not expose libbpf_version.h
# CFLAGS=-DCGROUP_SOCK_MARK_LIBBPF_USE_PROG_LOAD=0   # bpf_load_program
# CFLAGS=-DCGROUP_SOCK_MARK_LIBBPF_USE_PROG_LOAD=1   # bpf_prog_load (libbpf 1.x, e.g. Ubuntu 26.04)
all:
	gcc $(CFLAGS) cgroup_sock_mark.c -o cgroup_sock_mark -l bpf
	strip cgroup_sock_mark

dep:
	sudo apt install -y libbpf-dev

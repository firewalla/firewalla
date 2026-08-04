all:
	gcc cgroup_sock_mark.c -o cgroup_sock_mark -l bpf
	strip cgroup_sock_mark

dep:
	sudo apt install -y libbpf-dev

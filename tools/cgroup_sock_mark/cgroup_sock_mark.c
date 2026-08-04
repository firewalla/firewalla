/*
 * Auto mark sockets with give mark argument for any sockets within a cgroup
 */

#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <inttypes.h>
#include <linux/bpf.h>
#include <bpf/bpf.h>
#include "bpf_insn.h"

char bpf_log_buf[BPF_LOG_BUF_SIZE];

static int prog_load(__u32 mark)
{
  /* save pointer to context */
  struct bpf_insn prog_start[] = {
  };

  struct bpf_insn prog_end[] = {
    BPF_MOV64_IMM(BPF_REG_0, 1), /* r0 = verdict */
    BPF_EXIT_INSN(),
  };

  /* set mark on socket */
  struct bpf_insn prog_mark[] = {
    BPF_MOV64_IMM(BPF_REG_3, mark),
    BPF_STX_MEM(BPF_W, BPF_REG_1, BPF_REG_3, offsetof(struct bpf_sock, mark)),
  };

  struct bpf_insn *prog;
  size_t insns_cnt;
  void *p;
  int ret;

  insns_cnt = sizeof(prog_start) + sizeof(prog_end) + sizeof(prog_mark);

  p = prog = malloc(insns_cnt);
  if (!prog) {
    fprintf(stderr, "Failed to allocate memory for instructions\n");
    return EXIT_FAILURE;
  }

  memcpy(p, prog_start, sizeof(prog_start));
  p += sizeof(prog_start);
  memcpy(p, prog_mark, sizeof(prog_mark));
  p += sizeof(prog_mark);
  memcpy(p, prog_end, sizeof(prog_end));
  p += sizeof(prog_end);

  insns_cnt /= sizeof(struct bpf_insn);
  ret = bpf_load_program(BPF_PROG_TYPE_CGROUP_SOCK, prog, insns_cnt,
                         "GPL", 0, bpf_log_buf, BPF_LOG_BUF_SIZE);

  free(prog);
  return ret;
}

static unsigned int get_somark(int sd)
{
  unsigned int mark = 0;
  socklen_t optlen = sizeof(mark);
  int rc;
  rc = getsockopt(sd, SOL_SOCKET, SO_MARK, &mark, &optlen);
  if (rc < 0)
    perror("getsockopt(SO_MARK)");
  return mark;
}

static int show_sockopts(int family)
{
  unsigned int mark, prio;
  char name[16];
  int sd;
  sd = socket(family, SOCK_DGRAM, 17);
  if (sd < 0) {
    perror("socket");
    return 1;
  }
  mark = get_somark(sd);
  close(sd);
  printf("sd %d: mark %u\n", sd, mark);
  return 0;
}

static int usage(const char *argv0)
{
  printf("Usage:\n");
  printf("  Attach a program\n");
  printf("  %s -m mark cg-path\n", argv0);
  printf("\n");
  printf("  Detach a program\n");
  printf("  %s -d cg-path\n", argv0);
  printf("\n");
  printf("  Show inherited socket settings (mark)\n");
  printf("  %s [-6]\n", argv0);
  return EXIT_FAILURE;
}

int main(int argc, char **argv)
{
  __u32 idx = 0, mark = 0, prio = 0;
  const char *cgrp_path = NULL;
  int cg_fd, prog_fd, ret;
  int family = PF_INET;
  int do_attach = 1;
  int rc;

  while ((rc = getopt(argc, argv, "dm:")) != -1) {
    switch (rc) {
    case 'd':
      do_attach = 0;
      break;
    case 'm':
      mark = strtoumax(optarg, NULL, 0);
      break;
    default:
      return usage(argv[0]);
    }
  }

  if (optind == argc)
    return show_sockopts(family);

  cgrp_path = argv[optind];
  if (!cgrp_path) {
    fprintf(stderr, "cgroup path not given\n");
    return EXIT_FAILURE;
  }

  if (do_attach && !mark) {
    fprintf(stderr,
            "Mark must be given\n");
    return EXIT_FAILURE;
  }

  cg_fd = open(cgrp_path, O_DIRECTORY | O_RDONLY);
  if (cg_fd < 0) {
    printf("Failed to open cgroup path: '%s'\n", strerror(errno));
    return EXIT_FAILURE;
  }

  if (do_attach) {
    prog_fd = prog_load(mark);
    if (prog_fd < 0) {
      printf("Failed to load prog: '%s'\n", strerror(errno));
      printf("Output from kernel verifier:\n%s\n-------\n",
             bpf_log_buf);
      return EXIT_FAILURE;
    }
    ret = bpf_prog_attach(prog_fd, cg_fd,
                          BPF_CGROUP_INET_SOCK_CREATE, 0);
    if (ret < 0) {
      printf("Failed to attach prog to cgroup: '%s'\n",
             strerror(errno));
      return EXIT_FAILURE;
    }
  } else {
    ret = bpf_prog_detach(cg_fd, BPF_CGROUP_INET_SOCK_CREATE);
    if (ret < 0) {
      printf("Failed to detach prog from cgroup: '%s'\n",
             strerror(errno));
      return EXIT_FAILURE;
    }
  }

  close(cg_fd);
  return EXIT_SUCCESS;
}

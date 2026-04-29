#! /usr/bin/env bash
SRC_HOST="pi@192.168.203.191"
SRC_BASE_DIR="/home/pi/ws/build_kernel_module/output"


#GOLD
gold_kernels=( \
'4.15.0-70-generic' \
'5.15.0-27-generic' \
'5.4.0-88-generic' \
'6.5.0-25-generic' )

#GSE
gse_kernels=( \
'5.10.110' \
'5.10.110-NS' \
'5.10.160' \
)

#Navy
navy_kernels=( \
'5.4.50' \
)

#Purple
purple_kernels=( \
'4.9.241-firewalla' \
)

#GoldPro
gp_kernels=( \
'6.5.0-25-generic' \
)

#PSE
pse_kernels=( \
'5.15.78' \
)


function update_kernel_modules() {
	echo $1
	echo $2
	local kernel_array_name=$1
	local product=$2

	eval "local length=\${#$kernel_array_name[@]}"
	echo "length:"$length
	CMDDIR=$(dirname $0)
	FIREWALLA_HOME=$(cd $CMDDIR; git rev-parse --show-toplevel)
	
	for (( i=0; i<$length; i++ )); do
		eval "local kernel=\${$kernel_array_name[$i]}"
		echo "kernel version:"$kernel
		
		for module_name in "xt_udp_tls" "xt_tls"; do
			local cmd="scp ${SRC_HOST}:${SRC_BASE_DIR}/${kernel}/${module_name}.ko ${FIREWALLA_HOME}/platform/${product}/files/kernel_modules/${kernel}/${module_name}.ko"
			if [[ ${product} = 'gse' && ${kernel} = '5.10.110-NS' ]]; then
				cmd="scp ${SRC_HOST}:${SRC_BASE_DIR}/${kernel}/${module_name}.ko ${FIREWALLA_HOME}/platform/${product}/files/kernel_modules/5.10.110/${module_name}.ko.1b33aa1cb114bb2640c5bfe838118b3e"
			fi
			echo $cmd
			$cmd
		done
	done
}


# MAIN start
update_kernel_modules gold_kernels gold

update_kernel_modules gse_kernels gse

update_kernel_modules navy_kernels navy

update_kernel_modules purple_kernels purple

update_kernel_modules gp_kernels goldpro

update_kernel_modules pse_kernels pse




#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

if [ -f ~/.fwrc ]; then
  source ~/.fwrc
fi

image=""
image_tag=""

# override image_tag from command line
if [ -n "$1" ]; then
  image_tag=$1
fi

function cleanup_dangling_images() {
    sudo docker images --filter "reference=public.ecr.aws/a0j1s2e9/freeradius*" -f "dangling=true" -q | xargs -r sudo docker rmi
}

function wait_for_freeradius_start() {
    local timeout=60
    local start_time=$(date +%s)
    while ! sudo docker ps -q -f "name=freeradius_freeradius_1" | grep -q .; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        if [ $elapsed -ge $timeout ]; then
            echo "Timeout waiting for freeradius server to start after ${timeout}s"
            break
        fi
        sleep 5
    done
    if ! sudo docker ps -q -f "name=freeradius_freeradius_1" | grep -q .; then
        echo "Freeradius server is not running"
        return 1
    else
        echo "Freeradius server is running"
        return 0
    fi
}

# get image tag
function get_image_tag() {
  image_tag=$(redis-cli hget policy:system freeradius_server | jq -r '.options.image_tag // empty')
  if [ -z "$image_tag" ]; then
      image_tag=$(get_release_type|tail -n 1)
      if [[ "$image_tag" == "dev" || "$image_tag" == "unknown" ]]; then
        image_tag="dev"
      fi
  fi
}

function get_image() {
  if [[ "$image_tag" == "dev" || "$image_tag" == "test" ]]; then
    image="public.ecr.aws/a0j1s2e9/freeradius-dev:${image_tag}"
  else
    image="public.ecr.aws/a0j1s2e9/freeradius:${image_tag}"
  fi
}

if [ -z "$image_tag" ]; then
  get_image_tag
  get_image
fi

cleanup_dangling_images

echo "checking current image ${image}"
current_image=$(sudo docker images --format "{{.ID}}" --filter "reference=${image}")
if [ -z "$current_image" ]; then
  echo "image ${image} not found"
fi

echo "pulling image ${image}"
sudo docker pull ${image}
if [ $? -ne 0 ]; then
  echo "failed to pull image ${image}"
else
  echo "image ${image} pulled successfully"
fi

new_image=$(sudo docker images --format "{{.ID}}" --filter "reference=${image}")
if [ -z "$new_image" ]; then
  echo "image ${image} not found"
  exit 1
fi

updated=false
if [[ "$current_image" == "$new_image" ]]; then
  echo "image ${image} is up to date"
else 
  updated=true
  echo "image ${image} is updated"
fi

# restart freeradius server if feature is on
feature_on=$(redis-cli hget sys:features freeradius_server)

# check if freeradius server is running on latest image
if [[ "$feature_on" == "1" ]]; then
    running_image_name=$(sudo docker ps --format='{{.Image}}' --filter "name=freeradius_freeradius_1" 2>/dev/null)
    running_image_full=$(sudo docker inspect --format='{{.Image}}' freeradius_freeradius_1 2>/dev/null)
    running_image=$(echo "$running_image_full" | sed 's/sha256://' | cut -c1-12)
    if [[ -n "$running_image" && "$running_image" != "$new_image" ]]; then
      echo "running freeradius container is not on latest image (running on ${running_image}), updating to ${new_image}"
      updated=true
    fi
    if [[ "$updated" == true ]]; then
        ## need to update docker-compose.yml image
        if [ -f "/home/pi/.firewalla/run/docker/freeradius/docker-compose.yml" ]; then
          sed -i -E "s|image: ['\"]?${running_image_name}['\"]?|image: '${image}'|" /home/pi/.firewalla/run/docker/freeradius/docker-compose.yml
          echo "docker-compose.yml image updated from ${running_image_name} to ${image}"
        fi
        sudo systemctl restart docker-compose@freeradius
        # check if freeradius server is running
        if [ $? -ne 0 ]; then
            echo "failed to restart freeradius server"
        else
            echo "freeradius server restarted successfully"
            wait_for_freeradius_start
            if [ $? -ne 0 ]; then
                echo "failed to wait for freeradius server to start"
            fi
        fi
    fi
else 
    # check if any freeradius container is running then delete
    echo "feature disabled, checking to delete running freeradius container"
    tags=$(sudo docker images --filter "reference=public.ecr.aws/a0j1s2e9/freeradius*" --format "{{.Repository}}:{{.Tag}}")
    for tag in $tags; do
        sudo docker ps -a -q -f "ancestor=$img" | xargs -r sudo docker rm -f
    done
    echo "remaining freeradius containers cleaned up"
fi

# cleanup unexpected containers
sudo docker ps -a --format "{{.Names}}" -f "ancestor=${image}" | grep -v "^freeradius_freeradius_1$" | xargs -r sudo docker rm -f
echo "unexpected containers cleaned up"

# remove other freeradius images except the current image
tags=$(sudo docker images --filter "reference=public.ecr.aws/a0j1s2e9/freeradius*" --format "{{.Repository}}:{{.Tag}}" | grep -v ${image} | grep -v "none")
for tag in $tags; do
  sudo docker rmi $tag
done
echo "image tags ${tags} cleaned up"

# remove all dangling images
cleanup_dangling_images
echo "dangling images removed"

exit 0

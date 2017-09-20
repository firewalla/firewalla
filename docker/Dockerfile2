# DOCKER-VERSION 1.0.0
FROM ubuntu:16.04

# install required packages, in one command
RUN apt-get update
RUN apt-get install -y git curl sudo telnet netcat host
RUN apt-get install -y wget netcat inetutils-ping

RUN useradd -m pi -s /bin/bash && \
    echo "pi ALL=(ALL:ALL) NOPASSWD:ALL" >> /etc/sudoers

#RUN echo 'deb http://download.opensuse.org/repositories/network:/bro/xUbuntu_16.04/ /' >> /etc/apt/sources.list.d/bro.list

#RUN apt-get update
#RUN apt-get install bro -y --allow-unauthenticated

#RUN ln -s /opt/bro /usr/local/bro

RUN su - pi -c "git clone https://github.com/firewalla/firewalla.git"
RUN su - pi -c "cd firewalla ; ./buildraw"

RUN npm install -g nodemon

EXPOSE 8388
EXPOSE 8833
EXPOSE 8834

# run application
CMD service redis-server start; su - pi -c "cd firewalla; scripts/main-run"; su - pi -s /bin/bash
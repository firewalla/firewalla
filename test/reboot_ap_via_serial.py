import time
import serial
import sys
import logging

# Setup logging
logging.basicConfig(
    filename='serial_output.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

def ap_connect_serial():
    serial_port = '/dev/ttyUSB0'
    baud_rate = 115200
    timeout = 2

    username = ' '
    password = ' '

    ser = serial.Serial(serial_port, baud_rate, timeout=timeout)
    time.sleep(2)

    output = ser.read(ser.in_waiting)
    logging.info("Initial output: %s", output.decode(errors="ignore").strip())

    ser.write("fwap --version \r\n".encode())
    time.sleep(5)
    output = ser.read(ser.in_waiting)
    logging.info("fwap --version output: %s", output.decode(errors="ignore").strip())
    print("\r AP fwap output:", output.decode(errors="ignore"))

    ser.write("cat /etc/firewalla_release | grep version \r\n".encode())
    time.sleep(5)
    output = ser.read(ser.in_waiting)
    logging.info("Firmware version output: %s", output.decode(errors="ignore").strip())
    print("\r AP firmware version:", output.decode(errors="ignore"))

    ser.write("ethtool eth0 | grep Speed \r\n".encode())
    time.sleep(5)
    output = ser.read(ser.in_waiting)
    logging.info("Port speed output: %s", output.decode(errors="ignore").strip())
    print("\r Port speed of AP is:", output.decode(errors="ignore").replace(" ", " "))

    ser.write("reboot \r\n".encode())
    time.sleep(1)
    logging.info("Reboot command sent.")
    print("Reboot command executed.")

    ser.close()

if __name__ == "__main__":
    i = 1
    while True:
        print('='*20)
        print(f"Reboot iteration: {i}")
        print('='*20)
        print(f"CiG-224 is rebooting")
        logging.info("Starting reboot iteration %d", i)

        ap_connect_serial()
        time.sleep(150)

        print("Wait till AP's are back ONLINE !!!")
        logging.info("Waiting for AP to come back online.")
        i += 1


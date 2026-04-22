import subprocess
import time
import re

# Configure your mesh nodes
mesh_nodes = [
    {"ip": "192.168.201.84", "role": "ROOT"},
    {"ip": "192.168.10.198", "role": "SATELLITE"}
]

IPERF_DURATION = 10  # seconds


def run_command(cmd):
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        return result.stdout
    except Exception as e:
        return f"Error: {e}"


# -----------------------------
# Ping Test
# -----------------------------
def ping_test(host):
    output = run_command(["ping", "-c", "4", host])

    packet_loss = "N/A"
    latency = "N/A"

    for line in output.split("\n"):
        if "packet loss" in line:
            packet_loss = line.split(",")[2].strip()
        if "round-trip" in line or "rtt" in line:
            latency = line.split("=")[1].strip()

    return packet_loss, latency


# -----------------------------
# iPerf Test
# -----------------------------
def iperf_test(server_ip):
    print(f"🚀 Running iperf3 test to {server_ip}...")

    output = run_command([
        "iperf3",
        "-c", server_ip,
        "-t", str(IPERF_DURATION)
    ])

    #print(f"Iperf output is {output}")
    return output
#iperf_output = """YOUR_IPERF_OUTPUT_HERE"""

#----------------------
# PROCESS IPERF
#---------------------
def extract_receiver_bitrate(output):
    match = re.search(
        r"\[\s*\d+\].*?([\d\.]+\s+[GMK]bits/sec).*receiver",
        output
    )
    if match:
        return match.group(1)
    return "Not found"

#bitrate = extract_receiver_bitrate(output)

#print("📊 Receiver Throughput:", bitrate)

# -----------------------------
# Main Test
# -----------------------------
def test_mesh():
    print("\n🔍 Starting Mesh Network Test...\n")
    
    for i in range(99999):
        print("*"*30)
        print(f"Test iteration",i+1)
        print("*"*30)
        for node in mesh_nodes:
            ip = node["ip"]
            role = node["role"]

            #print(f"==============================")
            print(f"📡 Testing {role} ({ip})")

            # Ping Test
            packet_loss, latency = ping_test(ip)
            print(f"📶 {role} Packet Loss: {packet_loss}")
            print(f"⏱ {role} Latency: {latency}")

            # iPerf Test
            output = iperf_test(ip)
            TPUT = extract_receiver_bitrate(output)
            print(f"📊 {role} Throughput: {TPUT}")

            print("\n")
            time.sleep(2)


if __name__ == "__main__":
    test_mesh()

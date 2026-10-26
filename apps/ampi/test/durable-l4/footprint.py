#!/usr/bin/env python3
"""macOS phys_footprint via libproc. Never substitutes RSS or Linux PSS."""
import ctypes
import sys

# Darwin sys/resource.h, rusage_info_v4. Keep the native field order.
FIELDS = """
user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size
resident_size phys_footprint proc_start_abstime proc_exit_abstime
child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups
child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten
cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background
cpu_time_qos_utility cpu_time_qos_legacy cpu_time_qos_user_initiated
cpu_time_qos_user_interactive billed_system_time serviced_system_time
logical_writes lifetime_max_phys_footprint instructions cycles billed_energy
serviced_energy interval_max_phys_footprint runnable_time
""".split()

class RusageInfoV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in FIELDS]

if sys.platform != "darwin":
    raise SystemExit("phys_footprint requires Darwin; Linux smaps_rollup is a separate metric")
if len(sys.argv) < 2:
    raise SystemExit("usage: footprint.py PID...")
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
libproc.proc_pid_rusage.restype = ctypes.c_int
for value in sys.argv[1:]:
    pid = int(value)
    if pid <= 0:
        raise SystemExit("PID must be positive")
    info = RusageInfoV4()
    rc = libproc.proc_pid_rusage(pid, 4, ctypes.byref(info))
    print(pid, info.phys_footprint if rc == 0 else 0, ctypes.get_errno() if rc else 0)

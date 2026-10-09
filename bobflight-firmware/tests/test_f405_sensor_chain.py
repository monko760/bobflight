# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Same SPI/gyro tests, now driven by real GPIO preparation and BSRR chip select.
Sensor/clock responses remain modeled, not a physical hardware qualification.
"""
import unittest
import test_f405_spi_component as transport
class F405SensorChain(transport.F405SPI):
 WITH_GPIO=True
if __name__=='__main__':unittest.main()

# SPDX-License-Identifier: Apache-2.0
import io,sys,os,unittest,struct,zlib,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from tools.download_blackbox import SerialAdapter,parse_sd_read_response,FAT32Reader,FAT32Error,DeviceProtocolError,probe_sd_device,save_exclusive
from tools.test_download_blackbox import SparseCardFixture
class Wire:
    is_open=True
    def __init__(self,raw):self.raw=io.BytesIO(raw);self.sent=[]
    def reset_input_buffer(self):pass
    def write(self,b):self.sent.append(b)
    def flush(self):pass
    def read(self,n):return self.raw.read(min(n,53))
def response(lba,raw):
    return f'sd_data_api: 1\r\nsd_data_sector: {lba}\r\nsd_data_hex: {raw.hex().upper()}\r\nsd_data_crc32: {zlib.crc32(raw):08X}\r\nsd_data_end: 1\r\n'.encode()
class Integration(unittest.TestCase):
    def test_wire_spaced_end_and_crc(self):
        raw=bytes(range(256))*2;a=SerialAdapter('mock');a.ser=Wire(response(31,raw));lines=a.send_command('sd read 31',timeout=.5)
        self.assertEqual(parse_sd_read_response(lines,31),raw);self.assertEqual(a.ser.sent,[b'sd read 31\n'])
    def test_reject_before_transmit(self):
        a=SerialAdapter('mock');a.ser=Wire(b'')
        with self.assertRaises(DeviceProtocolError):a.send_command('arm')
        self.assertFalse(a.ser.sent)
    def test_total_reply_bound(self):
        a=SerialAdapter('mock');a.ser=Wire(b'x\n'*9000)
        with self.assertRaisesRegex(DeviceProtocolError,'maximum'):a.send_command('sd read 0',timeout=10)
    def test_partition_too_small(self):
        c=SparseCardFixture(partition_type='mbr');struct.pack_into('<I',c.sectors[0],446+12,10000)
        with self.assertRaises(FAT32Error):FAT32Reader(c.read_sector,c.card_sectors).mount()
    def test_small_fat(self):
        c=SparseCardFixture();struct.pack_into('<I',c.sectors[0],36,1)
        with self.assertRaises(FAT32Error):FAT32Reader(c.read_sector,c.card_sectors).mount()
    def test_names_and_duplicates(self):
        for kw in ({'duplicate_file':True},{'is_directory':True}):
            c=SparseCardFixture(**kw);f=FAT32Reader(c.read_sector,c.card_sectors);f.mount()
            with self.assertRaises(FAT32Error):f.read_file('BFL00001.BBL')
        with self.assertRaises(FAT32Error):f.read_file('../BFL00001.BBL')
    def test_framing_last_line(self):
        with self.assertRaises(DeviceProtocolError):parse_sd_read_response(response(0,bytes(512)).decode().splitlines()+['sd_data_api: 1'],0)
    def test_real_exclusive_output(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log.bbl';save_exclusive(p,b'first')
            with self.assertRaises(FileExistsError):save_exclusive(p,b'bad')
            self.assertEqual(p.read_bytes(),b'first')
    @unittest.skipUnless(os.environ.get('BOBFLIGHT_SPARSE_CARD'),'requires generated C writer fixture')
    def test_actual_c_writer_export(self):
        path=Path(os.environ['BOBFLIGHT_SPARSE_CARD']);b=path.read_bytes();capacity,count=struct.unpack_from('<II',b);self.assertEqual(len(b),8+count*516)
        sectors={struct.unpack_from('<I',b,8+i*516)[0]:b[12+i*516:524+i*516] for i in range(count)}
        def read(lba):return parse_sd_read_response(response(lba,sectors.get(lba,bytes(512))).decode().splitlines(),lba)
        f=FAT32Reader(read,capacity);f.mount();data=f.read_file('BFL00001.BBL')
        self.assertEqual(data,path.with_suffix('.bbl').read_bytes());save_exclusive(path.with_suffix('.export.bbl'),data)
if __name__=='__main__':unittest.main()

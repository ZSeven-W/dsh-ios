"""Rebuild the universal reader against AXe 1.8.0 (no runtime libraries vendored).
Inputs: official AXe release directory and source archive of
cameroncooke/idb@604c51013438f0c3603b720a05a44b7c5b8f286d.
"""
import argparse,pathlib,subprocess,tarfile,tempfile,shutil
p=argparse.ArgumentParser();p.add_argument('--axe-dir',required=True,type=pathlib.Path);p.add_argument('--idb-archive',required=True,type=pathlib.Path);a=p.parse_args();base=pathlib.Path(__file__).resolve().parent
assert subprocess.check_output([str(a.axe_dir/'axe'),'--version'],text=True).strip()=='1.8.0'
with tempfile.TemporaryDirectory(prefix='dsh-ax-build-') as temp:
 root=pathlib.Path(temp);fw=root/'Frameworks';shutil.copytree(a.axe_dir/'Frameworks',fw,symlinks=True)
 # Swift 6.4 cannot disambiguate older interfaces' module/class name collisions.
 # Qualify the same types locally; the linked official runtime libraries are unchanged.
 for file in (fw/'FBSimulatorControl.framework/Versions/A/Modules/FBSimulatorControl.swiftmodule').glob('*.swiftinterface'):
  file.write_text(file.read_text().replace('FBSimulatorControl.','').replace('IOSurface.IOSurface','IOSurface'))
 headers=root/'PrivateHeaders'
 with tarfile.open(a.idb_archive) as archive:
  for entry in archive.getmembers():
   parts=pathlib.PurePosixPath(entry.name).parts
   if entry.isfile() and len(parts)>2 and parts[1]=='PrivateHeaders':
    assert '..' not in parts
    out=headers/pathlib.Path(*parts[2:]);out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(archive.extractfile(entry).read())
 for arch in ['arm64','x86_64']:
  cmd=['xcrun','swiftc','-target',arch+'-apple-macos15.0','-parse-as-library','-O','-F',str(fw),'-framework','FBControlCore','-framework','FBSimulatorControl',str(base/'AXWorker.swift'),'-o',str(root/arch),'-Xlinker','-rpath','-Xlinker','@executable_path/Frameworks']
  for folder in [headers,*headers.iterdir()]:
   if folder.is_dir():cmd+=['-I',str(folder)]
  subprocess.run(cmd,check=True)
 subprocess.run(['xcrun','lipo','-create',str(root/'arm64'),str(root/'x86_64'),'-output',str(base/'dsh-ax-reader')],check=True)
 subprocess.run(['codesign','-f','-s','-',str(base/'dsh-ax-reader')],check=True)

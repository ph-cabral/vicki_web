package ar.com.everwear.vicki.wg;
import java.net.*; import java.util.*; import java.util.concurrent.*;
public class InteropTest {
  public static void main(String[] a) throws Exception {
    String mode = a[0]; byte[] priv = Base64.getDecoder().decode(a[1]); byte[] srvPub = Base64.getDecoder().decode(a[2]);
    final BlockingQueue<byte[]> toTun = new LinkedBlockingQueue<>(), fromNet = new LinkedBlockingQueue<>();
    WgTunnel.Tun tun = new WgTunnel.Tun(){
      public int read(byte[] b) throws java.io.IOException { try { byte[] p = toTun.poll(300, TimeUnit.MILLISECONDS); if (p==null) return 0; System.arraycopy(p,0,b,0,p.length); return p.length; } catch (InterruptedException e){ return 0; } }
      public void write(byte[] b,int off,int len){ fromNet.add(Arrays.copyOfRange(b,off,off+len)); }
    };
    WgTunnel.Config c = new WgTunnel.Config();
    c.privateKey = priv; c.peerPublicKey = srvPub; c.endpoint = new InetSocketAddress("127.0.0.1", 51999); c.keepaliveSec = 2;
    c.allowedIps = new String[]{"10.10.0.159/32","10.20.30.1/32"};
    final long[] hs = {0};
    WgTunnel t = new WgTunnel(c, tun, new DatagramSocket(), new WgTunnel.Listener(){
      public void onHandshake(long w){ hs[0]++; System.out.println("handshake #"+hs[0]); }
      public void onError(String m){ System.out.println("ERR "+m); }});
    t.start();
    int ok = 0;
    for (int i = 0; i < 6; i++) {
      int size = i == 3 ? 1280 : 20 + 4 + i * 7;
      byte[] p = new byte[size];
      p[0]=0x45; p[2]=(byte)(size>>8); p[3]=(byte)size; p[8]=64; p[9]=(byte)253;
      p[12]=10;p[13]=20;p[14]=30;p[15]=101; p[16]=10;p[17]=10;p[18]=0;p[19]=(byte)159;
      System.arraycopy("PING".getBytes(),0,p,20,4); for (int k=24;k<size;k++) p[k]=(byte)k;
      toTun.add(p);
      byte[] r = fromNet.poll(15, TimeUnit.SECONDS);
      if (r == null) { System.out.println("timeout pkt "+i); continue; }
      boolean good = r.length==size && new String(r,20,4).equals("PONG") && (r[15]&0xff)==159 && (r[19]&0xff)==101;
      for (int k=24;k<size && good;k++) good = r[k]==(byte)k;
      System.out.println("pkt "+i+" size="+size+" "+(good?"OK":"BAD"));
      if (good) ok++;
      if (i == 2) { Thread.sleep(3500); } if (i == 3) { t.rekeyNow(); Thread.sleep(800); } // deja correr keepalives
    }
    System.out.println("RESULT "+mode+" ok="+ok+"/6 handshakes="+hs[0]);
    t.stop(); System.exit(0);
  }
}

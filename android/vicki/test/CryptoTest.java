package ar.com.everwear.vicki.wg;
import javax.crypto.*; import javax.crypto.spec.*; import java.security.*; import java.security.spec.*; import java.util.*;
public class CryptoTest {
  static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte x:b)s.append(String.format("%02x",x));return s.toString();}
  public static void main(String[] a) throws Exception {
    System.out.println("blake2s abc " + hex(Blake2s.hash("abc".getBytes())).equals("508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982"));
    SecureRandom r = new SecureRandom();
    // chacha vs JDK
    for (int it=0; it<300; it++){
      byte[] k=new byte[32]; r.nextBytes(k); long ctr=r.nextLong()&Long.MAX_VALUE; int n=r.nextInt(1500); byte[] pt=new byte[n]; r.nextBytes(pt); byte[] aad=new byte[r.nextInt(70)]; r.nextBytes(aad);
      Cipher c=Cipher.getInstance("ChaCha20-Poly1305"); c.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(k,"ChaCha20"),new IvParameterSpec(ChaChaPoly.nonce(ctr))); c.updateAAD(aad);
      byte[] ref=c.doFinal(pt); byte[] mine=ChaChaPoly.seal(k,ctr,pt,aad);
      if(!Arrays.equals(ref,mine)){System.out.println("CHACHA FAIL n="+n+" aad="+aad.length);return;}
      byte[] back=ChaChaPoly.open(k,ctr,mine,0,mine.length,aad); if(!Arrays.equals(back,pt)){System.out.println("OPEN FAIL");return;}
      mine[r.nextInt(mine.length)]^=1; if(ChaChaPoly.open(k,ctr,mine,0,mine.length,aad)!=null){System.out.println("TAMPER FAIL");return;}
    }
    System.out.println("chachapoly ok");
    // x25519 vs JDK XDH
    KeyPairGenerator kpg=KeyPairGenerator.getInstance("X25519"); KeyFactory kf=KeyFactory.getInstance("X25519");
    for(int it=0;it<50;it++){
      byte[] p1=X25519.generatePrivate(r), p2=X25519.generatePrivate(r);
      byte[] pub2=X25519.publicKey(p2); byte[] s1=X25519.scalarMult(p1,pub2);
      KeyAgreement ka=KeyAgreement.getInstance("X25519");
      ka.init(kf.generatePrivate(new XECPrivateKeySpec(NamedParameterSpec.X25519,p1)));
      byte[] rev=pub2.clone(); for(int i=0;i<16;i++){byte t=rev[i];rev[i]=rev[31-i];rev[31-i]=t;}
      ka.doPhase(kf.generatePublic(new XECPublicKeySpec(NamedParameterSpec.X25519,new java.math.BigInteger(1,rev))),true);
      if(!Arrays.equals(ka.generateSecret(),s1)){System.out.println("X25519 FAIL");return;}
      if(!Arrays.equals(s1, X25519.scalarMult(p2, X25519.publicKey(p1)))){System.out.println("DH sym FAIL");return;}
    }
    // RFC 7748 vector
    byte[] k=hexb("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), u=hexb("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c");
    System.out.println("x25519 ok rfc=" + hex(X25519.scalarMult(k,u)).equals("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"));
  }
  static byte[] hexb(String s){byte[] b=new byte[s.length()/2];for(int i=0;i<b.length;i++)b[i]=(byte)Integer.parseInt(s.substring(2*i,2*i+2),16);return b;}
}

package ar.com.everwear.vicki.wg;
public class KeyGen { public static void main(String[] a){ byte[] p=X25519.generatePrivate(new java.security.SecureRandom()); System.out.println(java.util.Base64.getEncoder().encodeToString(p)+" "+java.util.Base64.getEncoder().encodeToString(X25519.publicKey(p))); } }

const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
module.exports=function reference(cases){
  const upstream=fs.readFileSync('../monad-bft/monad-raptorcast/src/packet/assigner.rs','utf8');
  const start=upstream.indexOf('    fn assign_round_robin('),open=upstream.indexOf('{',start);
  let end=open+1,depth=1;while(depth){if(upstream[end]==='{')depth++;if(upstream[end]==='}')depth--;end++;}
  if(start<0||end>=upstream.length)throw new Error('Upstream assignment method not found');
  const method=upstream.slice(start,end);
  const program=`
use std::{collections::VecDeque,marker::PhantomData,ops::Range,io::{self,BufRead}};
#[derive(Clone,Copy)] struct NodeIndex(usize);
#[derive(Clone,Copy)] struct Stake(u64);
trait Zero {fn is_zero(self)->bool;} impl Zero for u64 {fn is_zero(self)->bool {self==0}}
#[derive(Clone,Copy)] struct Redundancy;
impl Redundancy { fn scale(self,k:usize)->Option<usize>{k.checked_mul(5).map(|n|n.div_ceil(2))} }
struct ChunkAssignment<PT>{targets:Vec<usize>,marker:PhantomData<PT>}
impl<PT> ChunkAssignment<PT>{
fn with_capacity(n:usize,_nodes:Vec<usize>)->Self{Self{targets:Vec::with_capacity(n),marker:PhantomData}}
fn push(&mut self,n:NodeIndex,id:usize){assert_eq!(id,self.targets.len());self.targets.push(n.0);}
fn push_range(&mut self,n:NodeIndex,r:Range<usize>){for id in r{self.push(n,id)}}
fn num_chunks(&self)->usize{self.targets.len()}
}
struct StakePartition<PT>{validators:Vec<(usize,Stake)>,total:u64,marker:PhantomData<PT>}
impl<PT> StakePartition<PT>{
fn snapshot_nodes(&self)->Vec<usize>{self.validators.iter().map(|(n,_)|*n).collect()}
fn num_chunks_hint(&self,k:usize,r:Redundancy)->Option<usize>{r.scale(k)?.checked_add(self.validators.len())}
fn obligation(&self,n:usize,s:Stake)->Option<(usize,Stake)>{let p=(n as u128).checked_mul(s.0 as u128)?;Some(((p/self.total as u128).try_into().ok()?,Stake((p%self.total as u128) as u64)))}
${method}
}
fn main(){for line in io::stdin().lock().lines(){let line=line.unwrap();let nums:Vec<u64>=line.split_whitespace().map(|n|n.parse().unwrap()).collect();let p=StakePartition::<u8>{validators:nums[1..].iter().enumerate().map(|(i,n)|(i,Stake(*n))).collect(),total:nums[1..].iter().sum(),marker:PhantomData};let a=p.assign_round_robin(nums[0] as usize,Redundancy).unwrap();println!("{}",a.targets.iter().map(|n|n.to_string()).collect::<Vec<_>>().join(","));}}
`;
  fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/assignment-reference.rs',program);
  execFileSync('rustc',['+1.97.1','--edition=2021','test-results/assignment-reference.rs','-o','test-results/assignment-reference']);
  return execFileSync(path.resolve('test-results/assignment-reference'),[],{input:cases.map(c=>[c.k,...c.stakes].join(' ')).join('\n')+'\n',encoding:'utf8'}).trim().split('\n').map(l=>l.split(',').map(Number));
};
